# Channel 接口解析

## UDP 协议

NIO 使用 `DatagrmChannel` 实现了 UDP 协议的网络通讯

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411021832112.png" alt="image-20241102183255920" style="zoom: 33%;" />

下面我们对各个接口进行分析。

### AutoCloseable&Closeable

`AutoCloseable`和`Closeable`分别是自动关闭和主动关闭接口。当资源(如句柄或文件等)需要释放时，则需要调用 close 方法释放资源

```Java
public interface AutoCloseable {
    void close() throws Exception;
}
 
public interface Closeable extends AutoCloseable {
    void close() throws IOException;
}
```

* `AutoCloseable`：目的是与 `try-with-resources` 语句一起使用。`AutoCloseable` 更为通用，允许任何需要在不再使用时释放的资源实现它。它的 `close()` 方法可以抛出任意类型的异常

* `Closeable`：最初是为 I/O 资源（如 `InputStream`、`OutputStream` 和 `Reader` 等）设计的。`Closeable` 继承了 `AutoCloseable` 接口，但它的 `close()` 方法只能抛出 `IOException`（受检异常），因此更适合处理 I/O 类的资源。


### Channel

`Channel`是通道接口，针对于I/O相关的操作，需要打开和关闭操作。

```Java
public interface Channel extends Closeable {
    boolean isOpen();
 
    void close() throws IOException;
}
```

### InterruptibleChannel

Java传统IO是不支持中断的，因此如果代码在 `read`、`write` 等操作中阻塞时，无法被中断。这使得它无法与 `Thread` 的 `interrupt` 模型配合使用。

Java NIO 的众多升级点之一就是支持IO操作中的中断。`InterruptibleChannel` 表示支持中断的 `Channel`。常用的 `FileChannel`、`SocketChannel` 和 `DatagramChannel` 都实现了这个接口。

```Java
public interface InterruptibleChannel extends Channel{
    /**
      * 关闭当前Channel
      *     
      * 任何当前阻塞在当前channel执行的IO操作上的线程，都会收到一个AsynchronousCloseException异常
      */

    public void close() throws IOException;

}
```

`InterruptibleChannel` 接口没有定义任何方法，其中的 `close` 方法是继承自父接口的，这里只是添加了额外的注释。

`AbstractInterruptibleChannel` 实现了 `InterruptibleChannel` 接口，并提供了实现可中断 IO 机制的重要方法，例如 `begin()` 和 `end()`。

在解读这些方法的代码之前，我们先了解一下 NIO 中支持中断的 `Channel` 是如何编写的。

第一个要求是要正确使用 `begin()` 和 `end()` 方法：

```java
boolean completed = false;

try {
    begin();

    completed = ...;    // 执行阻塞IO操作

    return ...;         // 返回结果

} finally {

    end(completed);

}
```

NIO 规定，在阻塞 IO 的语句前后，需要调用 `begin()` 和 `end()` 方法。为了保证 `end()` 方法一定被调用，要求将其放在 `finally` 语句块中。

第二个要求是 `Channel` 需要实现 `java.nio.channels.spi.AbstractInterruptibleChannel#implCloseChannel` 这个方法。`AbstractInterruptibleChannel` 在处理中断时，会调用这个方法，利用 `Channel` 的具体实现来关闭 `Channel`。

接下来，我们具体看一下 `begin()` 和 `end()` 方法是如何实现的。

#### begin方法

```java
 // 保存中断处理对象实例
 private Interruptible interruptor;
 // 保存被中断线程实例
 private volatile Thread interrupted;
 protected final void begin() {

     // 初始化中断处理对象，中断处理对象提供了中断处理回调
     // 中断处理回调登记被中断的线程，然后调用implCloseChannel方法，关闭Channel
     if (interruptor == null) {
         interruptor = new Interruptible() {
             public void interrupt(Thread target) {
                 synchronized (closeLock) {
                     // 如果当前Channel已经关闭，则直接返回
                    if (!open) // 在JDK11中已经换为closed来做这个状态维护了
                         return;
                    // 设置标志位，同时登记被中断的线程
                    open = false;
                     interrupted = target;
                     try {
                        // 调用具体的Channel实现关闭Channel
                         AbstractInterruptibleChannel.this.implCloseChannel();
                    } catch (IOException x) { }
                 }
            }};

     }
     // 登记中断处理对象到当前线程

     blockedOn(interruptor);
     // 判断当前线程是否已经被中断，如果已经被中断，可能登记的中断处理对象没有被执行，这里手动执行一下
     Thread me = Thread.currentThread();
     if (me.isInterrupted())
         interruptor.interrupt(me);
 }
```

从 `begin()` 方法中，我们可以看出 NIO 实现可中断 IO 操作的思路是在 `Thread` 的中断逻辑中**挂载**自定义的中断处理对象。这样，当 `Thread` 被中断时，会执行中断处理对象中的回调，在回调中执行关闭 `Channel` 的操作。这样就实现了 `Channel` 对线程中断的响应。

接下来重点是研究“`Thread` 添加中断处理逻辑”这个机制是如何实现的，它是通过 `blockedOn` 方法实现的：

```java
static void blockedOn(Interruptible intr) {         // package-private
    sun.misc.SharedSecrets.getJavaLangAccess().blockedOn(Thread.currentThread(),intr);
}
```

`blockedOn` 方法使用的是 `JavaLangAccess` 的 `blockedOn` 方法。

`SharedSecrets` 是一个既神奇又糟糕的类。之所以说它糟糕，是因为这个方法的存在，正是为了访问 JDK 类库中一些由于类作用域限制而外部无法访问的类或方法。许多 JDK 中的类和方法是私有的或包级别私有的，外部无法直接访问。但是 JDK 在实现过程中，类与类之间往往存在相互依赖的情况。为了避免外部依赖反射来访问这些类或方法，在 `sun` 包下，存在这样一个类，提供了超越访问限制的方法。

`SharedSecrets.getJavaLangAccess()` 方法返回一个 `JavaLangAccess` 对象。正如其名称所示，`JavaLangAccess` 提供了对 `java.lang` 包下某些非公开方法的访问。这个类在 `System` 初始化时被构造。

```java
 // java.lang.System#setJavaLangAccess

 private static void setJavaLangAccess() {
    sun.misc.SharedSecrets.setJavaLangAccess(new sun.misc.JavaLangAccess(){
         public void blockedOn(Thread t, Interruptible b) {
             t.blockedOn(b);
        }

        //...
     });
 }
```

可以看出，`sun.misc.JavaLangAccess#blockedOn`保证的就是`java.lang.Thread#blockedOn`这个包级别私有的方法：

```java
/* The object in which this thread is blocked in an interruptible I/O
  * operation, if any.  The blocker's interrupt method should be invoked
  * after setting this thread's interrupt status.
  */

private volatile Interruptible blocker;
private final Object blockerLock = new Object();

/* Set the blocker field; invoked via sun.misc.SharedSecrets from java.nio code
  */
void blockedOn(Interruptible b) {
    // 串行化blocker相关操作
    synchronized (blockerLock) {
        blocker = b;
    }
}
```

这个方法非常简单，它的作用就是设置 `java.lang.Thread#blocker` 变量为之前提到的中断处理对象。从注释中可以看出，这个方法专门为 NIO 设计，注释明确指出，NIO 的代码会通过 `sun.misc.SharedSecrets` 调用这个方法。

接下来是重头戏，我们来看看**当 `Thread` 被中断时，如何调用 NIO 注册的中断处理器**：

```java
public void interrupt() {

    if (this != Thread.currentThread())

        checkAccess();

    synchronized (blockerLock) {

        Interruptible b = blocker;

        // 如果NIO设置了中断处理器，则只需Thread本身的中断逻辑后，调用中断处理器的回调函数
        if (b != null) {

            interrupt0();           // 这一步会设置interrupt标志位

            b.interrupt(this);
            return;

        }

    }

    // 如果没有的话，就走普通流程
    interrupt0();

}
```

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411032045914.png" alt="image-20241103204500849" style="zoom: 67%;" />

#### end方法

`begin()` 方法负责将 `Channel` 的中断处理器添加到当前线程。

`end()` 方法是在 IO 操作执行完或被中断后的操作，它负责判断是否发生了中断。如果发生了中断，会检查是当前线程发生的中断，还是其他线程中断了当前操作的 `Channel`。根据不同的情况，`end()` 方法会抛出不同的异常。

```java
protected final void end(boolean completed) throws AsynchronousCloseException
{
    // 清空线程的中断处理器引用，避免线程一直存活导致中断处理器无法被回收
    blockedOn(null);
    Thread interrupted = this.interrupted;
    if (interrupted != null && interrupted == Thread.currentThread()) {
        interrupted = null;
        throw new ClosedByInterruptException();
    }
    // 如果这次没有读取到数据，并且Channel被另外一个线程关闭了，则排除Channel被异步关闭的异常
    if (!completed && !open)
        throw new AsynchronousCloseException();
}
```

通过代码可以看出，如果是当前线程被中断，则会抛出 `ClosedByInterruptException` 异常，表示 `Channel` 因为线程中断而被关闭，IO 操作也随之中断。

如果是当前线程发现 `Channel` 被关闭了，并且是在读取尚未执行完毕的情况下，则会抛出 `AsynchronousCloseException` 异常，表示 `Channel` 被异步关闭。

`end()` 逻辑的活动图如下：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411032047284.png" alt="image-20241103204753221" style="zoom:67%;" />

#### 场景分析

并发场景的分析是复杂的，尽管上述代码不多，但场景非常多。我们以 `sun.nio.ch.FileChannelImpl#read(java.nio.ByteBuffer)` 为例来分析一下可能的场景：

1. **A线程进行 `read`，B线程中断A线程：**
   A线程抛出 `ClosedByInterruptException` 异常，表示 `Channel` 因线程中断而被关闭，IO 操作中断。
2. **A、B线程同时进行 `read`，C线程中断A线程：**
   - **A被中断时，B刚刚进入 `read` 方法：**
     A线程抛出 `ClosedByInterruptException` 异常，B线程在执行 `ensureOpen` 方法时抛出 `ClosedChannelException` 异常，表示 `Channel` 已关闭。
   - **A被中断时，B阻塞在底层 `read` 方法中：**
     A线程抛出 `ClosedByInterruptException` 异常，B线程在底层方法中抛出异常并返回，`end` 方法中会抛出 `AsynchronousCloseException` 异常，表示 `Channel` 被异步关闭。
   - **A被中断时，B已经读取到数据：**
     A线程抛出 `ClosedByInterruptException` 异常，B线程正常返回。

`sun.nio.ch.FileChannelImpl#read(java.nio.ByteBuffer)` 的代码如下：

```java
public int read(ByteBuffer dst) throws IOException {

    ensureOpen();  // 1

    if (!readable) // 2

        throw new NonReadableChannelException();

    synchronized (positionLock) {

        int n = 0;

        int ti = -1;

        try {            

            begin();

            ti = threads.add();

            if (!isOpen())

                return 0; // 3

            do {
                n = IOUtil.read(fd, dst, -1, nd); // 4

            } while ((n == IOStatus.INTERRUPTED) && isOpen());

            return IOStatus.normalize(n);

        } finally {

            threads.remove(ti);

            end(n > 0);

            assert IOStatus.check(n);

        }

    }
}
```

同样，对于`sun.nio.ch.ServerSocketChannelImpl`也不例外。

```java
/**
* Marks the beginning of an I/O operation that might block.
*
* @throws ClosedChannelException if the channel is closed
* @throws NotYetBoundException if the channel's socket has not been bound yet
*/
private void begin(boolean blocking) throws ClosedChannelException {
    if (blocking)
        begin();  // set blocker to close channel if interrupted
    synchronized (stateLock) {
        ensureOpen();
        if (localAddress == null)
            throw new NotYetBoundException();
        if (blocking)
            thread = NativeThread.current();
    }
}

/**
* Marks the end of an I/O operation that may have blocked.
*
* @throws AsynchronousCloseException if the channel was closed due to this
* thread being interrupted on a blocking I/O operation.
*/
private void end(boolean blocking, boolean completed)
    throws AsynchronousCloseException
{
    if (blocking) {
        synchronized (stateLock) {
            thread = 0;
            // notify any thread waiting in implCloseSelectableChannel
            if (state == ST_CLOSING) {
                stateLock.notifyAll();
            }
        }
        end(completed);
    }
}


//sun.nio.ch.ServerSocketChannelImpl#accept()
@Override
public SocketChannel accept() throws IOException {
    acceptLock.lock();
    try {
        int n = 0;
        FileDescriptor newfd = new FileDescriptor();
        InetSocketAddress[] isaa = new InetSocketAddress[1];

        boolean blocking = isBlocking();
        try {
            begin(blocking);
            do {
                n = accept(this.fd, newfd, isaa);
            } while (n == IOStatus.INTERRUPTED && isOpen());
        } finally {
            end(blocking, n > 0);
            assert IOStatus.check(n);
        }

        if (n < 1)
            return null;

        // newly accepted socket is initially in blocking mode
        IOUtil.configureBlocking(newfd, true);

        InetSocketAddress isa = isaa[0];
        SocketChannel sc = new SocketChannelImpl(provider(), newfd, isa);

        // check permitted to accept connections from the remote address
        SecurityManager sm = System.getSecurityManager();
        if (sm != null) {
            try {
                sm.checkAccept(isa.getAddress().getHostAddress(), isa.getPort());
            } catch (SecurityException x) {
                sc.close();
                throw x;
            }
        }
        return sc;

    } finally {
        acceptLock.unlock();
    }
}
```

#### 总结

在 Java IO 时代，为了中断 IO 操作，人们想了不少方法，核心操作就是关闭流，从而促使 IO 操作抛出异常，达到中断 IO 的效果。

::: code-group

```java [关闭流来中断 IO 操作]
InputStream inputStream = ...;
Thread interruptThread = new Thread(() -> {
    // 在某些条件下中断流
    inputStream.close();
});
interruptThread.start();

try {
    int data = inputStream.read();  // 阻塞操作
} catch (IOException e) {
    // 捕获异常，处理中断
}
```
```java [使用 Thread.interrupt() 中断线程]
InputStream inputStream = ...;

Thread interruptThread = new Thread(() -> {
    // 在某些条件下中断线程
    Thread.currentThread().interrupt();
});
interruptThread.start();

try {
    while (!Thread.interrupted()) {
        int data = inputStream.read();
        // 进行IO操作
    }
} catch (IOException e) {
    // 捕获异常，处理中断
}
```
```java [通过超时控制实现中断]
Socket socket = new Socket();
socket.setSoTimeout(5000);  // 设置5秒超时

try {
    socket.getInputStream().read();  // 可能会阻塞
} catch (SocketTimeoutException e) {
    // 捕获超时异常，表示IO被中断
}

```


:::

而在 NIO 中，这个操作被集成到了 `java.lang.Thread#interrupt` 方法中，免去了用户编写特定代码的麻烦。这样，IO 操作可以像其他可中断的方法一样，在中断时抛出 `ClosedByInterruptException` 异常，业务程序只需捕获该异常，就能对 IO 中断做出响应。

### SelectableChannel

`SelectableChannel`接口声明了Channel是可以被选择的，在Windows平台通过`WindowsSelectorImpl`实现，Linux通过`EPollSelectorImpl`实现。此外还有`KQueue`等实现，关于`Selector`具体细节在[《Selector 源码分析》](/netty_source_code_parsing/nio/Selector)一文中会介绍。

`AbstractSelectableChannel`实现了`SelectableChannel`接口。

### NetworkChannel

`NetworkChannel`适用于网络传输的接口。

```Java
public interface NetworkChannel extends Channel {
    //绑定地址
    NetworkChannel bind(SocketAddress var1) throws IOException;
 
    //获取本地地址
    SocketAddress getLocalAddress() throws IOException;
 
    //设置socket选项
    <T> NetworkChannel setOption(SocketOption<T> var1, T var2) throws IOException;
    
    //获取socket选项
    <T> T getOption(SocketOption<T> var1) throws IOException;
    
    //当前通道支持的socket选项
    Set<SocketOption<?>> supportedOptions();
}
```

### MulticastChannel

`MulticastChannel`是支持组播接口。

```Java
public interface MulticastChannel extends NetworkChannel {
    void close() throws IOException;
 
    MembershipKey join(InetAddress group, NetworkInterface interf) throws IOException;
 
    MembershipKey join(InetAddress group, NetworkInterface interf, InetAddress source) throws IOException;
}
```

### SelChImpl

`SelChImpl`接口用于将底层的I/O就绪状态更新为就绪事件。

```Java
public interface SelChImpl extends Channel {
 
    FileDescriptor getFD();
    int getFDVal();
    //更新就绪事件
    public boolean translateAndUpdateReadyOps(int ops, SelectionKeyImpl sk);
    //设置就绪事件
    public boolean translateAndSetReadyOps(int ops, SelectionKeyImpl sk);
    //将底层的轮询操作转换为事件
    void translateAndSetInterestOps(int ops, SelectionKeyImpl sk);
    //返回channle支持的操作，比如读操作、写操作等
    int validOps();
    void kill() throws IOException;
}
```

### ReadableByteChannel&WritableByteChannel

由于 UDP 支持读写数据，因此还实现了`ReadableByteChannel`和`WritableByteChannel`接口

```Java
public interface ReadableByteChannel extends Channel {
    int read(ByteBuffer dst) throws IOException;
}   
 
public interface WritableByteChannel extends Channel {
    int write(ByteBuffer src) throws IOException;
}
```

### ByteChannel

`ByteChannel`是支持读写的通道。

```Java
public interface ByteChannel extends ReadableByteChannel, WritableByteChannel {
}
```

### ScatteringByteChannel&GatheringByteChannel

`ScatteringByteChannel`则支持根据传入偏移量读,支持根据传入偏移量写`GatheringByteChannel`

```Java
public interface ScatteringByteChannel extends ReadableByteChannel {
    long read(ByteBuffer[] dsts, int offset, int length) throws IOException;
    long read(ByteBuffer[] dsts) throws IOException;
}
public interface GatheringByteChannel extends WritableByteChannel {
    long write(ByteBuffer[] srcs, int offset, int length) throws IOException;
    long write(ByteBuffer[] srcs) throws IOException;
}
```

## TCP 协议

### 客户端

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411131341305.png" alt="image-20241113134015529" style="zoom:67%;" />

TCP 协议除了不支持组播，其他和 UDP 是一样的,不再重复介绍。

### 服务端

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411131340767.png" alt="image-20241113134030704" style="zoom: 67%;" />

服务端无需数据读写，仅需要接收连接，数据读写是SocketChannel干的事。因此没有`ReadableByteChannel`、`WriteableByteChannel`等读写接口

## 文件

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411131340728.png" alt="image-20241113134044655" style="zoom:67%;" />

文件比网络协议少了`NetworkChannel`、`SelChImpl`和`SelectableChannel`。`SelChImpl`和`SelectableChannel`主要是用于支持选择器的，由于网络传输大多数连接时空闲的，而且数据何时会到来并不知晓，同时需要支持高并发来连接，因此支持多路复用技术可以显著的提高性能，而磁盘读写则没有该需求，因此无需选择器。

`SeekableByteChannel`可以通过修改 `position` 支持从指定位置读写数据。

```Java
public interface SeekableByteChannel extends ByteChannel {
    int read(ByteBuffer dst) throws IOException;
 
    int write(ByteBuffer src) throws IOException;
    
    long position() throws IOException;
    //设置偏移量
    SeekableByteChannel position(long newPosition) throws IOException;
 
    long size() throws IOException;
    //截取指定大小
    SeekableByteChannel truncate(long size) throws IOException;
}
```

