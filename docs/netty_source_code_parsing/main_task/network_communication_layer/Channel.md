# Netty Channel 源码解析

## 概述

全文围绕下图 *Netty-Channel* 的简化版架构体系图展开，从顶层 `Channel` 接口开始入手，逐层深入分析。我们直接进入正题，逐步讲解架构设计。

**概述：** 从图中可以看到，从顶级接口 `Channel` 开始，接口中定义了一套方法作为规范，紧接着是两个抽象的接口实现类。在这些抽象类中，对接口中的方法进行了部分实现。然后，根据不同的功能需求，系统将其分为服务端的 `Channel` 和客户端的 `Channel`。

通过这种结构设计，Netty 能够灵活地处理不同类型的网络通信需求，同时保持代码的可扩展性和复用性。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411211414748.png" alt="image-20241121141445704" style="zoom: 80%;" />

### Channel 的分类

根据服务端和客户端，Channel可以分成两类：

- 服务端: `NioServerSocketChannel`
- 客户端: `NioSocketChannel`

### Channel 是什么

`Channel` 是一个管道，用于连接字节缓冲区 `Buf` 和另一端的实体。这个实体可以是 `Socket`，也可以是 `File`。在 NIO 网络编程模型中，服务端和客户端之间的 IO 数据交互（即彼此推送的信息）的媒介就是 `Channel`。

Netty 对 JDK 原生的 `ServerSocketChannel` 进行了封装和增强，将其封装成了 `NioXXXChannel`。与原生的 JDK `Channel` 相比，Netty 的 `Channel` 增加了以下组件：

- **id**：标识唯一身份信息
- **可能存在的 parent Channel**：用于标识父 `Channel`
- **管道（pipeline）**：用于处理事件和数据
- **用于数据读写的 `unsafe` 内部类**：执行底层的 IO 操作
- **关联的 `NioEventLoop`**：与 `Channel` 终生绑定，负责事件循环和 IO 处理

本文将追溯上图中的体系关系，分析 `NioXXXChannel` 相对于 JDK 原生 `Channel` 的改进，找出这些新组件是如何添加的。

::: warning `JDK NIO Channel` vs `Netty Channel`

Netty 的 `Channel` 是对 Java NIO `Channel` 的进一步封装和扩展，提供了更强大且易用的功能，帮助开发者更高效地进行网络编程。

:::

## Channel 接口

在 [《JDK NIO 专栏》](/netty_source_code_parsing/nio/Buffer)中，echo 带你深入学习了 JDK NIO 包中的关于非阻塞通信的相关组件，接下来，在本文中，我们主要深入 Netty 中的`Channel` 接口相关的源码

![image-20241121135255223](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411211352258.png)



### Channel 接口的源码注释

网络套接字或能够执行 I/O 操作的组件的接口，例如读取、写入、连接和绑定。

一个通道提供以下功能给用户：

- 通道的当前状态（如是否已打开、是否已连接等）
- 通道的配置参数（例如接收缓冲区大小）
- 通道支持的 I/O 操作（如读取、写入、连接和绑定）
- 处理与通道相关的所有 I/O 事件和请求的管道

**所有 I/O 操作都是异步的**

在 Netty 中，所有的 I/O 操作都是异步进行的。这意味着任何 I/O 调用都会立即返回，且无法保证请求的 I/O 操作在调用结束时已经完成。相反，会返回一个实例，通知您该 I/O 操作是否成功、失败或被取消。

**通道是分层的**

一个通道可以有一个父通道，具体取决于它是如何创建的。例如， ServerSocketChannel 接受的 SocketChannel，在 parent() 中会返回 ServerSocketChannel 作为其父通道。

分层结构的语义依赖于通道所属的传输实现。例如，您可以编写一个新的通道实现，它创建共享一个套接字连接的子通道，就像 BEEP 和 SSH 所做的那样。

**向下转型以访问特定于传输的操作**

一些传输会暴露额外的操作，这些操作是特定于传输的。可以将通道向下转型为子类型来调用这些操作。例如，对于旧的 I/O 数据报传输，多播加入/离开操作由 DatagramChannel 提供。

**释放资源**

完成对通道的操作后，务必调用 close() 或 close(ChannelPromise) 来释放所有资源。这确保了所有资源能够以正确的方式被释放，例如文件句柄。

### Unsafe 子接口

在 Netty 中，真正帮助 `Channel` 完成 IO 读写操作的是它的内部类 `unsafe`。这个类提供了许多底层操作的实现，许多重要的功能都在这个接口中定义。以下是 `unsafe` 接口的源码和常用方法的列举：

```java
interface Unsafe {
    //  把channel注册进EventLoop
    void register(EventLoop eventLoop, ChannelPromise promise);

     // todo 给channel绑定一个 adress,
    void bind(SocketAddress localAddress, ChannelPromise promise);

    // 把channel注册进Selector
    void deregister(ChannelPromise promise);

    // 从channel中读取IO数据
    void beginRead();

    // 往channe写入数据
    void write(Object msg, ChannelPromise promise);
    ...
}
```

**源码注释如下：**

不安全的操作，这些操作永远不应该从用户代码中调用。这些方法仅用于实现实际的传输，并且必须从 I/O 线程中调用，除了以下方法：

- `localAddress()`
- `remoteAddress()`
- `closeForcibly()`
- `register(EventLoop, ChannelPromise)`
- `deregister(ChannelPromise)`
- `voidPromise()`

### AbstractChannel 抽象类

接着往下看，`Channel` 接口的直接实现类是 `AbstractChannel`，它是一个抽象类。`AbstractChannel` 重写了部分 `Channel` 接口预定义的方法，并且其内部抽象类 `AbstractUnsafe` 实现了 `Channel` 的内部接口 `unsafe`。

我们现在是从上往下看，了解类的层次结构和实现。但在实际使用时，我们通常会创建特化的对象。创建这些特化对象时，往往需要依赖层层调用父类的构造方法。因此，我们可以来看一下 `AbstractChannel` 的构造方法做了什么工作。

```java
protected AbstractChannel(Channel parent) {
    this.parent = parent;
    //  channelId 代表Chanel唯一的身份标志
    id = newId();
    //  创建一个unsafe对象
    unsafe = newUnsafe();
    //  在这里初始化了每一个channel都会有的pipeline组件
    pipeline = newChannelPipeline();
}
```

我们来看一下 `AbstractChannel` 的构造函数。它只接受一个子类传递进来的参数`parent Channel`，而且这个 `parent Channel` 有可能为空。因此，在 `AbstractChannel` 中并没有直接维护 JDK 底层的 `Channel`。相反，它会维护与 `Channel` 相关联的 `EventLoop`。我是怎么知道的呢？首先，在它的属性中就有这个字段。其次，`Channel` 被注册到 `Selector` 的 `register()` 方法是 `AbstractChannel` 重写的，而 `Selector` 又存在于 `EventLoop` 中。那么它是如何得到的呢？答案是，它的子类已经传递给了它。

至此，我们终于能够理解构造方法完成的四个主要任务：

* 设置 `parent`；
  * 如果当前创建的是客户端的 `Channel`，则将 `parent` 初始化为其对应的 `parent`，
  * 如果是服务端的 `Channel`，则 `parent` 为 `null`；

* 创建唯一的 `id`；
* 创建用于执行 `Channel` 的 I/O 读写操作的 `unsafe`；
* 创建 `Channel` 的处理器链 (`ChannelPipeline`)。

总结来说，`AbstractChannel` 维护着与之关联的 `EventLoop`，它通过子类的实现与底层的 `Selector` 进行交互。

### AbstractUnsafe 抽象类

**`AbstractChanel`的重要抽象内部类`AbstractUnsafe` 继承了`Channel`的内部接口`Unsafe`**

**`AbstractUnsafe` 中的 `register` 和 `bind` 在[《事件调度层》](/netty_source_code_parsing/main_task/event_scheduling_layer/reactor_dispatch)中会有详细提及**

### AbstractNioChannel 抽象类

#### 构造方法

依然是来到`AbstractNioChannel`的构造方法,发现它做了如下的构造工作:

- 把parent传递给了`AbstractChannel`
- 把子类传递过来的Channel要告诉Selector的感兴趣的选项保存
- 设置channel为非阻塞

```java
protected AbstractNioChannel(Channel parent, SelectableChannel ch, int readInterestOp) {
    super(parent);
    this.ch = ch;
    this.readInterestOp = readInterestOp;
    try {
        ch.configureBlocking(false);
    } catch (IOException e) {
        try {
            ch.close();
        } catch (IOException e2) {
            logger.warn(
                "Failed to close a partially initialized socket.", e2);
        }

        throw new ChannelException("Failed to enter non-blocking mode.", e);
    }
}
```

#### 重写 doRegister

`AbstractNioChannel` 维护了 `channel` 的引用，真正的实现将 JDK 原生的 `Channel` 注册到 `Selector` 中。

```java
@Override
protected void doRegister() throws Exception {
    boolean selected = false;
    for (;;) {
        try {
            selectionKey = javaChannel().register(eventLoop().unwrappedSelector(), 0, this);
            return;
        } catch (CancelledKeyException e) {
            if (!selected) {
                // Force the Selector to select now as the "canceled" SelectionKey may still be
                // cached and not removed because no Select.select(..) operation was called yet.
                eventLoop().selectNow();
                selected = true;
            } else {
                // We forced a select operation on the selector before but the SelectionKey is still cached
                // for whatever reason. JDK bug ?
                throw e;
            }
        }
    }
}
```

#### 新增内部接口 read

`AbstractNioChannel` 新添加了一个内部接口，作为原 `Channel` 的扩展，源码如下。我们关注的重点是这个新接口的 `read()` 方法。它的作用是从 `Channel` 读取 I/O 数据。作为接口的抽象方法，它规范了服务端和客户端根据各自的需求来实现不同的 `read()` 方法。

**如何特化实现这个 `read()` 方法？**

- **服务端**：在服务端，`read()` 的结果通常是一个新的客户端连接。当客户端通过网络连接到服务端时，`read()` 会触发从底层 `Channel` 读取客户端连接的事件。这个过程在服务端是特定的，因为服务端需要监听并接受来自客户端的连接请求。
- **客户端**：对于客户端来说，`read()` 的结果是客户端接收到的数据。当客户端发送请求到服务器时，`read()` 会读取服务器返回的数据。因此，客户端的 `read()` 方法需要根据接收到的数据进行处理。

这个 `read()` 方法的特化实现对于服务端和客户端来说是非常必要的，因为它们的需求完全不同——服务端需要处理连接的建立，而客户端则关注于数据的接收。因此，`read()` 方法需要根据不同的场景进行定制化实现。

`AbstractNioChannel` 的抽象内部类继承了它父类的 `AbstractUnsafe`，并实现了当前的 `NioUnsafe`。接下来，问题来了，服务端和客户端针对 `read` 的特化实现在哪里呢？

显然，它们应该在子类的 `unsafe` 内部类中。如下图所示，特化的实现位于紫色框框内。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411211511962.png" alt="image-20241121151155853" style="zoom: 50%;" />

## Channel#bind

`bind`方法的调用栈如下:

```java
io.netty.channel.AbstractChannel#bind(java.net.SocketAddress)
io.netty.channel.DefaultChannelPipeline#bind(java.net.SocketAddress)
io.netty.channel.AbstractChannelHandlerContext#bind(java.net.SocketAddress)　　io.netty.channel.AbstractChannelHandlerContext#bind(java.net.SocketAddress, io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannelHandlerContext#invokeBind
io.netty.channel.DefaultChannelPipeline.HeadContext#bind
io.netty.channel.AbstractChannel.AbstractUnsafe#bind
io.netty.channel.socket.nio.NioSocketChannel#doBind
io.netty.channel.socket.nio.NioSocketChannel#doBind0
```

为了简明地展示调用关系，这个调用栈省略了一些细节，可能存在多个 `AbstractChannelHandlerContext` 的方法在不同线程中被调用。在以后描述调用栈时，也会忽略这一点，不再赘述。

`io.netty.channel.AbstractChannel.AbstractUnsafe#bind` 执行了主要的 `bind` 逻辑，它会调用 `doBind`，然后当 `channel` 的状态从 `inactive` 变为 `active` 时，调用 `pipeline` 的 `fireChannelActive` 方法触发 `channelActive` 事件。`doBind` 是 `io.netty.channel.AbstractChannel` 定义的抽象方法。`NioSocketChannel` 只需要实现这个方法，整个 `bind` 功能就完整了。

```java
@Override
protected void doBind(SocketAddress localAddress) throws Exception {
    doBind0(localAddress);
}
private void doBind0(SocketAddress localAddress) throws Exception {
    if (PlatformDependent.javaVersion() >= 7) {
        SocketUtils.bind(javaChannel(), localAddress);
    } else {
        SocketUtils.bind(javaChannel().socket(), localAddress);
    }
}
```

`SocketUtils` 封装了通过 `AccessController` 调用 JDK 的 `socket` API 接口，实际上还是调用 `Socket` 或 `SocketChannel` 的 `bind` 方法。`Nio` 的三个 `Channel` 类实现 `doBind` 的代码几乎相同。

## Channel#connect

`connect`的调用栈如下:

```java
io.netty.channel.AbstractChannel#connect(java.net.SocketAddress)
io.netty.channel.DefaultChannelPipeline#connect(java.net.SocketAddress)
io.netty.channel.AbstractChannelHandlerContext#connect(java.net.SocketAddress)
io.netty.channel.AbstractChannelHandlerContext#connect(java.net.SocketAddress, io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannelHandlerContext#connect(java.net.SocketAddress, java.net.SocketAddress, io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannelHandlerContext#invokeConnect
io.netty.channel.DefaultChannelPipeline.HeadContext#connect
io.netty.channel.nio.AbstractNioChannel.AbstractNioUnsafe#connect
io.netty.channel.socket.nio.NioSocketChannel#doConnect
```

`connect` 的主要逻辑在 `io.netty.channel.nio.AbstractNioChannel.AbstractNioUnsafe#connect` 中实现，流程如下：

1. 调用 `doConnect` 方法，这个方法是 `AbstractNioChannel` 定义的抽象方法。
2. 如果 `doConnect` 成功，且 `channel` 的状态从 `inactive` 变为 `active`，则调用 `pipeline` 的 `fireChannelActive` 方法触发 `channelActive` 事件。
3. 如果 `doConnect` 失败，调用 `close` 关闭 `channel`。

在 `io.netty.channel.socket.nio.NioSocketChannel#doConnect` 中，实际是调用了 `socket` 的 `connect` API。以下是 `connect` 的关键代码：

```java
@Override
public final void connect(
        final SocketAddress remoteAddress, final SocketAddress localAddress, final ChannelPromise promise) {
    if (!promise.setUncancellable() || !ensureOpen(promise)) {
        return;
    }

    try {
        if (connectPromise != null) {
            // Already a connect in process.
            throw new ConnectionPendingException();
        }

        boolean wasActive = isActive();
        if (doConnect(remoteAddress, localAddress)) {
            fulfillConnectPromise(promise, wasActive);
        } else {
            connectPromise = promise;
            requestedRemoteAddress = remoteAddress;

            // Schedule connect timeout.
            int connectTimeoutMillis = config().getConnectTimeoutMillis();
            if (connectTimeoutMillis > 0) {
                connectTimeoutFuture = eventLoop().schedule(new Runnable() {
                    @Override
                    public void run() {
                        ChannelPromise connectPromise = AbstractNioChannel.this.connectPromise;
                        ConnectTimeoutException cause =
                                new ConnectTimeoutException("connection timed out: " + remoteAddress);
                        if (connectPromise != null && connectPromise.tryFailure(cause)) {
                            close(voidPromise());
                        }
                    }
                }, connectTimeoutMillis, TimeUnit.MILLISECONDS);
            }

            promise.addListener(new ChannelFutureListener() {
                @Override
                public void operationComplete(ChannelFuture future) throws Exception {
                    if (future.isCancelled()) {
                        if (connectTimeoutFuture != null) {
                            connectTimeoutFuture.cancel(false);
                        }
                        connectPromise = null;
                        close(voidPromise());
                    }
                }
            });
        }
    } catch (Throwable t) {
        promise.tryFailure(annotateConnectException(t, remoteAddress));
        closeIfClosed();
    }
}

private void fulfillConnectPromise(ChannelPromise promise, boolean wasActive) {
    if (promise == null) {
        return;
    }
    boolean active = isActive();
    boolean promiseSet = promise.trySuccess();

    if (!wasActive && active) {
        pipeline().fireChannelActive();
    }
    if (!promiseSet) {
        close(voidPromise());
    }
}
```

第 14、15 行和整个 `fulfillConnectPromise` 方法处理的是正常流程。

第 18-52 行处理的是异常流程。代码虽然较多，但总结起来就是一句话：设置 `promise` 返回错误，确保能够调用 `close` 方法。

`io.netty.channel.socket.nio.NioSocketChannel#doConnect` 的实现与 `doBind` 的实现类似：

```java
@Override
protected boolean doConnect(SocketAddress remoteAddress, SocketAddress localAddress) throws Exception {
    if (localAddress != null) {
        doBind0(localAddress);
    }

    boolean success = false;
    try {
        boolean connected = SocketUtils.connect(javaChannel(), remoteAddress);
        if (!connected) {
            selectionKey().interestOps(SelectionKey.OP_CONNECT);
        }
        success = true;
        return connected;
    } finally {
        if (!success) {
            doClose();
        }
    }
}
```

在第 11 行，注册了 `OP_CONNECT` 事件。由于 `channel` 在初始化时被设置为非阻塞模式，`connect` 方法可能会返回 `false`，如果返回 `false` 表示 `connect` 操作尚未完成，需要通过 `selector` 关注 `OP_CONNECT` 事件，将 `connect` 变成一个异步过程。只有在异步调用 `io.netty.channel.nio.AbstractNioChannel.AbstractNioUnsafe#finishConnect` 后，`connect` 操作才算完成。`finishConnect` 在 `eventLoop` 中被调用：

```java
// io.netty.channel.nio.NioEventLoop#processSelectedKey(java.nio.channels.SelectionKey, io.netty.channel.nio.AbstractNioChannel)
if ((readyOps & SelectionKey.OP_CONNECT) != 0) {
    int ops = k.interestOps();
    ops &= ~SelectionKey.OP_CONNECT;
    k.interestOps(ops);
    unsafe.finishConnect();
}
```

`finishConnect` 的实现如下：

```java
// io.netty.channel.nio.AbstractNioChannel.AbstractNioUnsafe#finishConnect
@Override
public final void finishConnect() {
    // Note this method is invoked by the event loop only if the connection attempt was
    // neither cancelled nor timed out.
    
    assert eventLoop().inEventLoop();
    try {
        boolean wasActive = isActive();
        doFinishConnect();
        fulfillConnectPromise(connectPromise, wasActive);
    } catch (Throwable t) {
        fulfillConnectPromise(connectPromise, annotateConnectException(t, requestedRemoteAddress));
    } finally {
        // Check for null as the connectTimeoutFuture is only created if a connectTimeoutMillis > 0 is used
        // See https://github.com/netty/netty/issues/1770
        if (connectTimeoutFuture != null) {
            connectTimeoutFuture.cancel(false);
        }
        connectPromise = null;
    }
}
```

`doFinishConnect` 方法：

```java
// io.netty.channel.socket.nio.NioSocketChannel#doFinishConnect
@Override
protected void doFinishConnect() throws Exception {
    if (!javaChannel().finishConnect()) {
        throw new Error();
    }
}
```

- 第 9-11 行是 `finishConnect` 的核心逻辑。首先调用 `doFinishConnect` 执行连接完成后的操作，`NioSocketChannel` 实现中会检查连接是否真的已经完成（第 27-29 行）。然后，调用 `fulfillConnectPromise` 来触发事件，并设置 `promise` 返回值。
- 在前面分析 `netty.channel.nio.AbstractNioChannel.AbstractNioUnsafe#connect` 时，可以看到在 `doConnect` 调用成功后会立即调用该方法。此方法被调用两次是为了确保 `channelActive` 事件一定会被触发一次。

------

## `localAddress` 和 `remoteAddress` 的实现：

这两个方法几乎相同，这里只分析 `localAddress`。其调用栈如下：

```java
io.netty.channel.AbstractChannel#localAddress
io.netty.channel.AbstractChannel.AbstractUnsafe#localAddress
io.netty.channel.socket.nio.NioSocketChannel#localAddress0
```

该方法不会触发任何事件，因此没有通过 `pipeline` 调用 `unsafe`，它直接调用 `unsafe` 的方法：

```java
// io.netty.channel.AbstractChannel#localAddress
@Override
public SocketAddress localAddress() {
    SocketAddress localAddress = this.localAddress;
    if (localAddress == null) {
        try {
            this.localAddress = localAddress = unsafe().localAddress();
        } catch (Throwable t) {
            // Sometimes fails on a closed socket in Windows.
            return null;
        }
    }
    return localAddress;
}
```

在第 7 行，直接调用了 `unsafe` 的 `localAddress` 方法，这个方法在 `AbstractUnsafe` 中实现，它调用了 `localAddress0`，这是一个 `protected` 的抽象方法，在 `NioSocketChannel` 中的实现如下：

```java
// io.netty.channel.socket.nio.NioSocketChannel#localAddress0
@Override
protected SocketAddress localAddress0() {
    return javaChannel().socket().getLocalSocketAddress();
}
```

## Channel#read

### Nio Channel 通知 eventLoop 开始读数据

`channel#read`方法的调用栈：

```shell
io.netty.channel.AbstractChannel#read
io.netty.channel.DefaultChannelPipeline#read
io.netty.channel.AbstractChannelHandlerContext#read
io.netty.channel.AbstractChannelHandlerContext#invokeRead
io.netty.channel.DefaultChannelPipeline.HeadContext#read
io.netty.channel.AbstractChannel.AbstractUnsafe#beginRead
io.netty.channel.nio.AbstractNioChannel#doBeginRead
```

调用 `channel` 的 `read` 方法会触发 `read` 事件，并通过 `pipeline` 调用 `AbstractChannel` 的 `unsafe` 的 `beginRead` 方法。这个方法的语义是通知 `eventLoop` 可以从 `channel` 读取数据了，但它并不实现具体功能，而是将具体功能留给 `doBeginRead` 来实现。

`doBeginRead` 方法在 `AbstractChannel` 中被定义为抽象方法。`AbstractNioChannel` 实现了这个方法，具体实现如下：

```java
@Override
protected void doBeginRead() throws Exception {
    // Channel.read() or ChannelHandlerContext.read() was called
    final SelectionKey selectionKey = this.selectionKey;
    if (!selectionKey.isValid()) {
        return;
    }

    readPending = true;

    final int interestOps = selectionKey.interestOps();
    if ((interestOps & readInterestOp) == 0) {
        selectionKey.interestOps(interestOps | readInterestOp);
    }
}
```

在 `doBeginRead` 的实现中，只有第17行是核心代码：它将 `readInterestOps`（即读取操作的标志）保存并添加到 `SelectableChannel` 的 `SelectionKey` 中。`readInterestOps` 是一个类的属性，在 `AbstractNioChannel` 中没有明确的定义，只有一个抽象的定义，它代表 NIO 中可以当作读取操作的标志。在 NIO 中，可以当作读取操作的标志有 `SelectionKey.OP_READ` 和 `SelectionKey.OP_ACCEPT`。

`readInterestOps` 在 `AbstractNioChannel` 的构造方法中通过传入的参数进行初始化，子类可以根据需要确定 `interestOps` 的具体含义。

在设置好 `beginRead` 后，`NioEventLoop` 就可以使用 `Selector` 来检测到 `channel` 上的读取事件了。接下来是 `NioEventLoop` 中处理读取事件的代码：

```java
//io.netty.channel.nio.NioEventLoop#processSelectedKey(java.nio.channels.SelectionKey,io.netty.channel.nio.AbstractNioChannel)
if ((readyOps & (SelectionKey.OP_READ | SelectionKey.OP_ACCEPT)) != 0 || readyOps == 0) {
    unsafe.read();
}
```

这里调用了 `unsafe` 的 `read` 方法，但在 `Channel` 的 `Unsafe` 中并没有定义这个方法。它实际上在 `io.netty.channel.nio.AbstractNioChannel.NioUnsafe` 中定义，并在 `io.netty.channel.nio.AbstractNioMessageChannel.NioMessageUnsafe` 和 `io.netty.channel.nio.AbstractNioByteChannel.NioByteUnsafe` 中有两个不同的实现。

这两个实现的区别在于：

- `NioMessageUnsafe.read` 方法将从 `channel` 中读出的数据转换成 `Object`。
- `NioByteUnsafe.read` 方法则是从 `channel` 中读出字节数据流。

接下来，我们将详细分析这两种实现的具体细节。

### 多态的 Read

Netty 在 NIO Channel 的设计上，将读取数据独立成一个抽象层。这样的设计有两个主要原因：

* **不同类型的 `Channel` 读取的数据类型不同**：

  - `NioServerSocketChannel` 读取的是一个新建的 `NioSocketChannel`。

  - `NioSocketChannel` 读取的是字节数据流。

  - `NioDatagramChannel` 读取的是数据报。

* **非阻塞模式下读取数据的复杂性**：

  - 在 NIO 中，三种不同的 `Channel` 都运行在非阻塞模式下。与阻塞模式相比，非阻塞模式下读取数据需要处理更多的复杂问题。使用 `Selector` 和非阻塞模式被动地读取数据时，必须处理连接断开和 socket 异常等情况。由于 `Selector` 是边缘触发模式，一次 `read` 调用必须将已经在 socket 的接收缓冲区中的数据全部读取出来，否则可能会导致数据丢失或接收不及时。

  - 将 `read` 操作独立出来，可以专门处理读取数据的复杂性，使得代码结构更加清晰。

接下来，我们将详细分析 `NioUnsafe` 中 `read` 方法的两种不同实现方式。

#### NioMessageUnsafe

这个实现的主要功能是调用 `doReadMessages` 方法，从 `channel` 中读取 `Object` 类型的消息，具体的类型并没有限制。`doReadMessages` 是一个抽象方法，留给子类实现。

下面是 `read` 方法的实现：

```java
@Override
public void read() {
    assert eventLoop().inEventLoop();
    final ChannelConfig config = config();
    final ChannelPipeline pipeline = pipeline();
    final RecvByteBufAllocator.Handle allocHandle = unsafe().recvBufAllocHandle();
    allocHandle.reset(config);

    boolean closed = false;
    Throwable exception = null;
    try {
        try {
            do {
                int localRead = doReadMessages(readBuf);
                if (localRead == 0) {
                    break;
                }
                if (localRead < 0) {
                    closed = true;
                    break;
                }

                allocHandle.incMessagesRead(localRead);
            } while (allocHandle.continueReading());
        } catch (Throwable t) {
            exception = t;
        }

        int size = readBuf.size();
        for (int i = 0; i < size; i ++) {
            readPending = false;
            pipeline.fireChannelRead(readBuf.get(i));
        }
        readBuf.clear();
        allocHandle.readComplete();
        pipeline.fireChannelReadComplete();

        if (exception != null) {
            closed = closeOnReadError(exception);

            pipeline.fireExceptionCaught(exception);
        }

        if (closed) {
            inputShutdown = true;
            if (isOpen()) {
                close(voidPromise());
            }
        }
    } finally {
        // Check if there is a readPending which was not processed yet.
        // This could be for two reasons:
        // * The user called Channel.read() or ChannelHandlerContext.read() in channelRead(...) method
        // * The user called Channel.read() or ChannelHandlerContext.read() in channelReadComplete(...) method
        //
        // See https://github.com/netty/netty/issues/2254
        if (!readPending && !config.isAutoRead()) {
            removeReadOp();
        }
    }
}
```

在第12行，获取每次循环读取的最大消息数量 `maxMessagesPerRead`。该配置的默认值因不同的 `channel` 类型而异，`io.netty.channel.ChannelConfig` 提供了 `setMaxMessagesPerRead` 方法来设置该配置的值。调节该值的大小会影响 I/O 操作在 `eventLoop` 线程中的执行时间。值越大，I/O 操作占用的时间就越长。

在第18至36行，使用 `doReadMessages` 方法读取消息，并将消息放入 `readBuf` 中，`readBuf` 是 `List<Object>` 类型。具体说明如下：

- 第20和21行：如果没有可读的数据，结束循环。
- 第23至25行：如果 `socket` 已经关闭，则结束循环。
- 第33和34行：如果 `readBuf` 中的消息数量超过限制，则跳出循环。

在第41至47行，对 `readBuf` 中的每一条消息触发一次 `channelRead` 事件，然后清空 `readBuf`，并触发 `channelReadComplete` 事件。

在第49至53行，处理异常。

在第55至59行，处理 `channel` 正常关闭。

`doReadMessages` 方法有两个实现：

- 一个是 `io.netty.channel.socket.nio.NioServerSocketChannel#doReadMessages`，该实现中读取的消息是 `NioSocketChannel`。
- 另一个是 `io.netty.channel.socket.nio.NioDatagramChannel#doReadMessages`，该实现中读取的消息是 `DatagramPacket`。

##### NioServerSocketChannel

```java
@Override
protected int doReadMessages(List<Object> buf) throws Exception {
    SocketChannel ch = SocketUtils.accept(javaChannel());

    try {
        if (ch != null) {
            buf.add(new NioSocketChannel(this, ch));
            return 1;
        }
    } catch (Throwable t) {
        logger.warn("Failed to create a new channel from an accepted socket.", t);

        try {
            ch.close();
        } catch (Throwable t2) {
            logger.warn("Failed to close a socket.", t2);
        }
    }

    return 0;
}
```

##### NioDatagramChannel

```java
@Override
protected int doReadMessages(List<Object> buf) throws Exception {
    DatagramChannel ch = javaChannel();
    DatagramChannelConfig config = config();
    RecvByteBufAllocator.Handle allocHandle = unsafe().recvBufAllocHandle();

    ByteBuf data = allocHandle.allocate(config.getAllocator());
    allocHandle.attemptedBytesRead(data.writableBytes());
    boolean free = true;
    try {
        ByteBuffer nioData = data.internalNioBuffer(data.writerIndex(), data.writableBytes());
        int pos = nioData.position();
        InetSocketAddress remoteAddress = (InetSocketAddress) ch.receive(nioData);
        if (remoteAddress == null) {
            return 0;
        }

        allocHandle.lastBytesRead(nioData.position() - pos);
        buf.add(new DatagramPacket(data.writerIndex(data.writerIndex() + allocHandle.lastBytesRead()),
                                   localAddress(), remoteAddress));
        free = false;
        return 1;
    } catch (Throwable cause) {
        PlatformDependent.throwException(cause);
        return -1;
    }  finally {
        if (free) {
            data.release();
        }
    }
}
```

#### NioByteUnsafe

这个实现的主要功能是调用 `doReadBytes` 方法读取字节流。`doReadBytes` 是一个抽象方法，留给子类实现。

下面是 `read` 方法的实现：

```java
@Override
public final void read() {
    final ChannelConfig config = config();
    if (shouldBreakReadReady(config)) {
        clearReadPending();
        return;
    }
    final ChannelPipeline pipeline = pipeline();
    final ByteBufAllocator allocator = config.getAllocator();
    final RecvByteBufAllocator.Handle allocHandle = recvBufAllocHandle();
    allocHandle.reset(config);

    ByteBuf byteBuf = null;
    boolean close = false;
    try {
        do {
            byteBuf = allocHandle.allocate(allocator);
            allocHandle.lastBytesRead(doReadBytes(byteBuf));
            if (allocHandle.lastBytesRead() <= 0) {
                // nothing was read. release the buffer.
                byteBuf.release();
                byteBuf = null;
                close = allocHandle.lastBytesRead() < 0;
                if (close) {
                    // There is nothing left to read as we received an EOF.
                    readPending = false;
                }
                break;
            }

            allocHandle.incMessagesRead(1);
            readPending = false;
            pipeline.fireChannelRead(byteBuf);
            byteBuf = null;
        } while (allocHandle.continueReading());

        allocHandle.readComplete();
        pipeline.fireChannelReadComplete();

        if (close) {
            closeOnRead(pipeline);
        }
    } catch (Throwable t) {
        handleReadException(pipeline, byteBuf, t, close, allocHandle);
    } finally {
        // Check if there is a readPending which was not processed yet.
        // This could be for two reasons:
        // * The user called Channel.read() or ChannelHandlerContext.read() in channelRead(...) method
        // * The user called Channel.read() or ChannelHandlerContext.read() in channelReadComplete(...) method
        //
        // See https://github.com/netty/netty/issues/2254
        if (!readPending && !config.isAutoRead()) {
            removeReadOp();
        }
    }
}
```

在第10至16行，获取一个接收缓冲区的分配器及其专用 `handle`。这两个组件的功能是高效地创建大量接收数据的缓冲区。具体的原理和实现将在后续的缓冲区相关章节中详细分析，暂时略过。

在第24至64行，这是一个使用 `doReadBytes` 读取数据并触发 `channelRead` 事件的循环。具体操作如下：

- 第25至27行：获取一个接收数据的缓冲区，并从 `socket` 中读取数据。
- 第28至38行：如果没有数据可读，或者 `socket` 已经断开，跳出循环。
- 第43行：如果正确收到了数据，触发 `channelRead` 事件。
- 第59至62行：如果读出的数据小于缓冲区的长度，表示 `socket` 中暂时没有数据可读。
- 第64行：如果读取次数超过了上限配置，跳出循环。

在第66行，读循环完成后，触发 `channelReadComplete` 事件。

在第69至72行，处理 `socket` 的正常关闭。

在第74至83行，处理其他异常。

`doReadBytes` 方法只有一个实现：

```java
// io.netty.channel.socket.nio.NioSocketChannel#doWriteBytes
@Override
protected int doWriteBytes(ByteBuf buf) throws Exception {
    final int expectedWrittenBytes = buf.readableBytes();
    return buf.readBytes(javaChannel(), expectedWrittenBytes);
}
```

这个实现非常简单，利用 `ByteBuf` 的能力从 `SocketChannel` 中读取字节流

## Channel#write&flush

写数据是 NIO `Channel` 实现的另一个比较复杂的功能。每个 `channel` 都有一个 `outboundBuffer`，即输出缓冲区。当调用 `channel` 的 `write` 方法写入数据时，这些数据会经过一系列的 `ChannelOutboundHandler` 处理，并最终放入这个缓冲区中，但此时数据并没有真正写入到 `socket channel` 中。只有在调用 `channel` 的 `flush` 方法时，`flush` 会将 `outboundBuffer` 中的数据真正写入到 `socket channel`。

在正常情况下，`flush` 之后，数据已经被真正写入。但在使用 `Selector` 和非阻塞 `socket` 的方式写数据时，写操作变得复杂。操作系统为每个 `socket` 维护了一个数据发送缓冲区，其长度由 `SO_SNDBUF` 参数定义。每次发送数据时，数据会先写入这个发送缓冲区，然后由操作系统负责将缓冲区中的数据发送出去，并清理该缓冲区。

当向发送缓冲区写入数据的速率超过操作系统的发送速率时，缓冲区可能会被填满。在非阻塞模式下，这种情况表现为：调用 `socket` 的 `write` 方法写入长度为 `n` 的数据，实际写入的数据长度 `m` 可能满足 `0 <= m <= n`。此时，剩余的 `n - m` 数据未能写入到 `socket`，而数据必须以正确的顺序完整地写入。

为了解决这个问题，`outboundBuffer` 被设计用来存储未能写入的数据。当 `发送缓冲区` 中有足够的空间时，剩余的数据会按照正确的顺序从 `outboundBuffer` 中取出，继续写入到 `socket` 中。

### 把数据写到outboundBuffer中

`write`调用栈

```shell
io.netty.channel.AbstractChannel#write(java.lang.Object)
io.netty.channel.DefaultChannelPipeline#write(java.lang.Object)
io.netty.channel.AbstractChannelHandlerContext#write(java.lang.Object)
io.netty.channel.AbstractChannelHandlerContext#write(java.lang.Object, io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannelHandlerContext#write(java.lang.Object, boolean, io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannelHandlerContext#invokeWrite
io.netty.channel.DefaultChannelPipeline.HeadContext#write
io.netty.channel.AbstractChannel.AbstractUnsafe#write
```

`write` 的主要逻辑在 `io.netty.channel.AbstractChannel.AbstractUnsafe#write` 中实现。该方法将要写的数据 `msg` 对象放入 `outboundBuffer` 中。

在执行 `close` 时，Netty 不希望再有新的数据写入，避免引起不可预料的错误，因此会将 `outboundBuffer` 置为 `null`。在向 `outboundBuffer` 写入数据之前，会先检查它是否为 `null`，如果为 `null`，则会抛出错误。

下面是 `write` 方法的实现：

```java
@Override
public final void write(Object msg, ChannelPromise promise) {
    assertEventLoop();

    ChannelOutboundBuffer outboundBuffer = this.outboundBuffer;
    if (outboundBuffer == null) {
        try {
            // release message now to prevent resource-leak
            ReferenceCountUtil.release(msg);
        } finally {
            // If the outboundBuffer is null we know the channel was closed and so
            // need to fail the future right away. If it is not null the handling of the rest
            // will be done in flush0()
            // See https://github.com/netty/netty/issues/2362
            safeSetFailure(promise,
                           newClosedChannelException(initialCloseCause, "write(Object, ChannelPromise)"));
        }
        return;
    }

    int size;
    try {
        msg = filterOutboundMessage(msg);
        size = pipeline.estimatorHandle().size(msg);
        if (size < 0) {
            size = 0;
        }
    } catch (Throwable t) {
        try {
            ReferenceCountUtil.release(msg);
        } finally {
            safeSetFailure(promise, t);
        }
        return;
    }

    outboundBuffer.addMessage(msg, size, promise);
}
```

第5至9行，对 `outboundBuffer` 进行检查，如果为 `null` 则抛出错误。这里有一个小细节：使用一个局部变量引用 `outboundBuffer`，以避免由于其他线程对 `this.outboundBuffer` 进行置空操作而引发错误。

在第14行，调用 `filterOutboundMessage` 对 `msg` 进行过滤。这个方法是 `protected` 的，默认实现什么都不做，直接返回输入的 `msg` 参数。子类可以覆盖这个方法，将 `msg` 转换为期望的类型。

在第15行，计算 `msg` 的长度。

在第25行，将 `msg` 放入 `outboundBuffer` 中。

### 把数据真正写到 channel

把数据真正写到 `channel`

`flush`调用栈：

```shell
io.netty.channel.AbstractChannel#flush
io.netty.channel.DefaultChannelPipeline#flush
io.netty.channel.AbstractChannelHandlerContext#flush
io.netty.channel.AbstractChannelHandlerContext#invokeFlush
io.netty.channel.DefaultChannelPipeline.HeadContext#flush
io.netty.channel.AbstractChannel.AbstractUnsafe#flush
io.netty.channel.AbstractChannel.AbstractUnsafe#flush0
io.netty.channel.socket.nio.NioSocketChannel#doWrite
io.netty.channel.nio.AbstractNioByteChannel#doWrite
io.netty.channel.socket.nio.NioSocketChannel#doWriteBytes
```

以上是 `io.netty.channel.socket.nio.NioSocketChannel` 的 `flush` 调用栈。对于 `io.netty.channel.socket.nio.NioDatagramChannel` 来说，从第8行开始，调用栈会有所不同：

```shell
...
io.netty.channel.AbstractChannel.AbstractUnsafe#flush0
io.netty.channel.nio.AbstractNioMessageChannel#doWrite
io.netty.channel.socket.nio.NioDatagramChannel#doWriteMessage
```



#### 把 Byte 数据流写入 channel

`io.netty.channel.socket.nio.NioSocketChannel#doWrite` 是处理 `Byte` 数据流的写逻辑，`io.netty.channel.nio.AbstractNioByteChannel#doWrite` 也是类似的逻辑。两者的不同之处在于：

- 前者是在 `outboundBuffer` 可以转换为 `java.nio.ByteBuffer` 时执行。
- 后者则是在 `outboundBuffer` 中的 `msg` 类型为 `ByteBuf` 或 `FileRegion` 时执行。

除此之外，其他的逻辑是相同的：

- 尽量将 `outboundBuffer` 中的数据写入 `channel`。
- 如果 `channel` 无法写入数据，则在 `channel` 的 `SelectionKey` 上注册 `OP_WRITE` 事件，等待 `channel` 可写时再继续写入。
- 如果写入次数超过限制，将 `flush` 操作包装成任务，放到 `eventLoop` 排队，等待再次执行。

接下来，我们来看一下 `io.netty.channel.socket.nio.NioSocketChannel#doWrite` 的实现代码：

```java
@Override
protected void doWrite(ChannelOutboundBuffer in) throws Exception {
    for (;;) {
        int size = in.size();
        if (size == 0) {
            // All written so clear OP_WRITE
            clearOpWrite();
            break;
        }
        long writtenBytes = 0;
        boolean done = false;
        boolean setOpWrite = false;

        // Ensure the pending writes are made of ByteBufs only.
        ByteBuffer[] nioBuffers = in.nioBuffers();
        int nioBufferCnt = in.nioBufferCount();
        long expectedWrittenBytes = in.nioBufferSize();
        SocketChannel ch = javaChannel();

        // Always us nioBuffers() to workaround data-corruption.
        // See https://github.com/netty/netty/issues/2761
        switch (nioBufferCnt) {
            case 0:
                // We have something else beside ByteBuffers to write so fallback to normal writes.
                super.doWrite(in);
                return;
            case 1:
                // Only one ByteBuf so use non-gathering write
                ByteBuffer nioBuffer = nioBuffers[0];
                for (int i = config().getWriteSpinCount() - 1; i >= 0; i --) {
                    final int localWrittenBytes = ch.write(nioBuffer);
                    if (localWrittenBytes == 0) {
                        setOpWrite = true;
                        break;
                    }
                    expectedWrittenBytes -= localWrittenBytes;
                    writtenBytes += localWrittenBytes;
                    if (expectedWrittenBytes == 0) {
                        done = true;
                        break;
                    }
                }
                break;
            default:
                for (int i = config().getWriteSpinCount() - 1; i >= 0; i --) {
                    final long localWrittenBytes = ch.write(nioBuffers, 0, nioBufferCnt);
                    if (localWrittenBytes == 0) {
                        setOpWrite = true;
                        break;
                    }
                    expectedWrittenBytes -= localWrittenBytes;
                    writtenBytes += localWrittenBytes;
                    if (expectedWrittenBytes == 0) {
                        done = true;
                        break;
                    }
                }
                break;
        }

        // Release the fully written buffers, and update the indexes of the partially written buffer.
        in.removeBytes(writtenBytes);

        if (!done) {
            // Did not write all buffers completely.
            incompleteWrite(setOpWrite);
            break;
        }
    }
}
```

第5至7行，如果 `outboundBuffer` 中已经没有数据了，调用 `clearOpWrite` 方法清除 `channel` `SelectionKey` 上的 `OP_WRITE` 事件。

第15至17行，将 `outboundBuffer` 转换为 `ByteBuffer` 类型，并获取数据的长度。

第25行，如果 `outboundBuffer` 不能转换为 `ByteBuffer`，则调用 `io.netty.channel.nio.AbstractNioByteChannel#doWrite` 执行写操作。

第29至42行，45至57行的逻辑基本相同，都是尽量将 `ByteBuffer` 中的数据写入 `channel`。当满足以下任意一个条件时，结束本次写操作：

1. `ByteBuffer` 中的数据已经写完，正常结束。
2. `channel` 已经不能写入数据，需要等 `channel` 可以写入时继续执行写操作。
3. 写入次数超过 `channel` 配置中的写入次数限制，需要选择合适的时机继续执行写操作。

第62行，将已经写入到 `channel` 的数据从 `outboundBuffer` 中删除。

第64至66行，如果数据没有写完，调用 `incompleteWrite` 处理未写完的情况。当 `setOpWrite` 为 `true` 时，在 `channel` 的 `SelectionKey` 上设置 `OP_WRITE` 事件，等待 `eventLoop` 触发该事件时再继续执行 `flush` 操作。否则，将 `flush` 操作包装成任务，放到 `eventLoop` 中排队执行。

当 `NioEventLoop` 检测到 `OP_WRITE` 事件时，会调用 `processSelectedKey` 方法来处理：

```java
if ((readyOps & SelectionKey.OP_WRITE) != 0) {
    ch.unsafe().forceFlush();
}
```

`forceFlush`的调用栈如下

```shell
io.netty.channel.nio.AbstractNioChannel.AbstractNioUnsafe#forceFlush
io.netty.channel.AbstractChannel.AbstractUnsafe#flush0
io.netty.channel.socket.nio.NioSocketChannel#doWrite
io.netty.channel.nio.AbstractNioByteChannel#doWrite
io.netty.channel.socket.nio.NioSocketChannel#doWriteBytes
```

#### 把数据写入 UDP 类型的 channel

`io.netty.channel.nio.AbstractNioMessageChannel#doWrite` 是数据报的写逻辑。相比于 `Byte` 流类型的数据，数据报的写逻辑要简单一些。它只是将 `outboundBuffer` 中的数据报依次写入到 `channel` 中。如果 `channel` 写满了，则在 `channel` 的 `SelectionKey` 上设置 `OP_WRITE` 事件，随后退出。之后，`OP_WRITE` 事件的处理逻辑与 `Byte` 流写逻辑相同。

真正的写操作在 `io.netty.channel.socket.nio.NioDatagramChannel#doWriteMessage` 中实现。该方法的实现如下：

```java
@Override
protected boolean doWriteMessage(Object msg, ChannelOutboundBuffer in) throws Exception {
    final SocketAddress remoteAddress;
    final ByteBuf data;
    if (msg instanceof AddressedEnvelope) {
        @SuppressWarnings("unchecked")
        AddressedEnvelope<ByteBuf, SocketAddress> envelope = (AddressedEnvelope<ByteBuf, SocketAddress>) msg;
        remoteAddress = envelope.recipient();
        data = envelope.content();
    } else {
        data = (ByteBuf) msg;
        remoteAddress = null;
    }

    final int dataLen = data.readableBytes();
    if (dataLen == 0) {
        return true;
    }

    final ByteBuffer nioData = data.internalNioBuffer(data.readerIndex(), dataLen);
    final int writtenBytes;
    if (remoteAddress != null) {
        writtenBytes = javaChannel().send(nioData, remoteAddress);
    } else {
        writtenBytes = javaChannel().write(nioData);
    }
    return writtenBytes > 0;
}
```

第5至9行，处理 `AddressedEnvelope` 类型的数据报，获取数据报的远程地址和数据。

第10至12行，如果发送的是一个 `ByteBuf` 且没有指定远程地址，则需要先调用 `channel` 的 `connect` 方法。

第20至26行，分别针对两种情况发送数据报。第23行指定了远程地址，第25行没有指定远程地址，但已经调用过 `connect` 方法。

## Channel#disconnect

**断开连接**

`disconnect`方法的调用栈如下:

```Java
io.netty.channel.AbstractChannel#disconnect()
io.netty.channel.DefaultChannelPipeline#disconnect()
io.netty.channel.AbstractChannelHandlerContext#disconnect()
io.netty.channel.AbstractChannelHandlerContext#disconnect(io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannelHandlerContext#invokeDisconnect
io.netty.channel.DefaultChannelPipeline.HeadContext#disconnect
io.netty.channel.AbstractChannel.AbstractUnsafe#disconnect
io.netty.channel.socket.nio.NioSocketChannel#doDisconnect
io.netty.channel.socket.nio.NioSocketChannel#doClose
```

`disconnect` 稍微复杂一些。在 `io.netty.channel.AbstractChannelHandlerContext#disconnect(io.netty.channel.ChannelPromise)` 的实现中，会根据 `channel` 是否支持 `disconnect` 操作来决定下一步的动作：

```java
if (!channel().metadata().hasDisconnect()) {
    next.invokeClose(promise);
} else {
    next.invokeDisconnect(promise);
}
```

之所以这样设计，是因为 TCP 和 UDP 的 `disconnect` 含义不同。对于 TCP 来说，`disconnect` 就是关闭 `socket`；而对于 UDP 来说，`disconnect` 并不代表关闭连接，因为 UDP 没有连接的概念。默认情况下，通过 UDP `socket` 发送数据时需要指定远程地址，但如果调用 `connect` 方法后，就不需要每次指定远程地址，数据报会自动发送到 `connect` 指定的地址。

因此，`disconnect` 在 UDP 中的含义是删除 `connect` 指定的地址，之后发送数据时必须重新指定地址。在 NIO 的 `Channel` 实现中，TCP 的 `disconnect` 是调用 `socket` 的 `close` 方法，而 UDP 的 `disconnect` 是调用 `socket` 的 `disconnect` 方法。以下是这两种不同的 `disconnect` 实现：

::: code-group 

```java [TCP]
//io.netty.channel.socket.nio.NioSocketChannel#doDisconnect
@Override
protected void doDisconnect() throws Exception {
    doClose();
}
@Override
protected void doClose() throws Exception {
    super.doClose();
    javaChannel().close();
}
```

```java [UDP]
//io.netty.channel.socket.nio.NioDatagramChannel#doDisconnect
@Override
protected void doDisconnect() throws Exception {
    javaChannel().disconnect();
}
```

:::

`io.netty.channel.AbstractChannel.AbstractUnsafe#disconnect` 实现了 `disconnect` 的逻辑。首先，它调用了 `doDisconnect` 方法，这个方法是 `io.netty.channel.AbstractChannel` 中定义的抽象方法。如果 `channel` 的状态从 `active` 变为 `inactive`，则会调用 `pipeline` 的 `fireChannelInactive` 方法触发 `channelInactive` 事件。

## Channel#close

`close`方法的调用栈:

```java
io.netty.channel.AbstractChannel#close()
io.netty.channel.DefaultChannelPipeline#close()
io.netty.channel.AbstractChannelHandlerContext#close()
io.netty.channel.AbstractChannelHandlerContext#close(io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannelHandlerContext#invokeClose
io.netty.channel.DefaultChannelPipeline.HeadContext#close
io.netty.channel.AbstractChannel.AbstractUnsafe#close(io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannel.AbstractUnsafe#close(final ChannelPromise promise, final Throwable cause ,final ClosedChannelException closeCause, final boolean notify)
io.netty.channel.AbstractChannel.AbstractUnsafe#doClose0
io.netty.channel.socket.nio.NioSocketChannel#doClose
```

`close` 的逻辑实现在 `io.netty.channel.AbstractChannel.AbstractUnsafe#close(final ChannelPromise promise, final Throwable cause, final ClosedChannelException closeCause, final boolean notify)` 方法中。这个 `close` 方法主要实现了以下几个功能：

- 确保在多线程环境下，多次调用 `close` 和一次调用的效果一致，并且可以通过 `promise` 得到相同的结果。
- 在执行 `close` 的过程中，保证不能向 `channel` 写数据。
- 调用 `doClose0` 执行真正的 `close` 操作。
- 调用 `deregister` 对 `channel` 进行最后的清理工作，并触发 `channelInactive` 和 `channelUnregistered` 事件。

以下是这个方法的实现代码：

```java
private void close(final ChannelPromise promise, final Throwable cause,
                   final ClosedChannelException closeCause, final boolean notify) {
    if (!promise.setUncancellable()) {
        return;
    }

    if (closeInitiated) {
        if (closeFuture.isDone()) {
            // Closed already.
            safeSetSuccess(promise);
        } else if (!(promise instanceof VoidChannelPromise)) { // Only needed if no VoidChannelPromise.
            // This means close() was called before so we just register a listener and return
            closeFuture.addListener(new ChannelFutureListener() {
                @Override
                public void operationComplete(ChannelFuture future) throws Exception {
                    promise.setSuccess();
                }
            });
        }
        return;
    }

    closeInitiated = true;

    final boolean wasActive = isActive();
    final ChannelOutboundBuffer outboundBuffer = this.outboundBuffer;
    this.outboundBuffer = null; // Disallow adding any messages and flushes to outboundBuffer.
    Executor closeExecutor = prepareToClose();
    if (closeExecutor != null) {
        closeExecutor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    // Execute the close.
                    doClose0(promise);
                } finally {
                    // Call invokeLater so closeAndDeregister is executed in the EventLoop again!
                    invokeLater(new Runnable() {
                        @Override
                        public void run() {
                            if (outboundBuffer != null) {
                                // Fail all the queued messages
                                outboundBuffer.failFlushed(cause, notify);
                                outboundBuffer.close(closeCause);
                            }
                            fireChannelInactiveAndDeregister(wasActive);
                        }
                    });
                }
            }
        });
    } else {
        try {
            // Close the channel and fail the queued messages in all cases.
            doClose0(promise);
        } finally {
            if (outboundBuffer != null) {
                // Fail all the queued messages.
                outboundBuffer.failFlushed(cause, notify);
                outboundBuffer.close(closeCause);
            }
        }
        if (inFlush0) {
            invokeLater(new Runnable() {
                @Override
                public void run() {
                    fireChannelInactiveAndDeregister(wasActive);
                }
            });
        } else {
            fireChannelInactiveAndDeregister(wasActive);
        }
    }
}
```

在 `close` 方法中，7-23 行的代码确保了 `close` 操作只会执行一次。这个操作由 `closeInitiated` 属性控制，尽管它是一个普通的 `boolean` 类型，且在多线程环境下可能会出现可见性问题，但实际上，`close` 方法只会在 `channel` 的 `eventLoop` 线程中执行。因此，尽管可能有多个线程调用 `channel.close()`，只有一个线程会执行关闭操作。

26-27 行，`outboundBuffer` 被设置为 `null`，这样所有通过 `write` 方法写入的数据都会通过 `promise` 返回错误，确保不会有数据在关闭过程中写入。

28 行，`prepareToClose` 是一个 `protected` 方法，默认返回 `null`。它可以被覆盖，用来在关闭前做一些准备工作，比如指定一个 `executor`，以便在指定的执行器中执行关闭操作。

33-49 行和 53-72 行的代码实现了相同的功能，只是前者在 `prepareToClose` 提供的 `executor` 中执行。主要步骤包括：

- 调用 `doClose0` 执行实际的关闭操作。
- 清理 `outboundBuffer`（43, 44 行）。
- 触发 `channelInactive` 和 `channelDeregister` 事件（46 行）。
- 使用 `inFlush0` 属性检查当前是否正在进行 `flush` 操作，如果是，确保 `flush` 完成后再触发事件。

在 `doClose0` 方法中，首先调用 `doClose` 执行实际的关闭操作，然后设置 `promise` 的返回值，完成关闭的最终步骤。

```java
//io.netty.channel.AbstractChannel.AbstractUnsafe#doClose0
private void doClose0(ChannelPromise promise) {
    try {
        doClose();
        closeFuture.setClosed();
        safeSetSuccess(promise);
    } catch (Throwable t) {
        closeFuture.setClosed();
        safeSetFailure(promise, t);
    }
}
//io.netty.channel.socket.nio.NioSocketChannel#doClose
@Override
protected void doClose() throws Exception {
    super.doClose();
    javaChannel().close();
}
```

`fireChannelInactiveAndDeregister` 是调用 `deregister` 实现的，也就是说，正常情况下，调用 `Channel` 的 `close` 方法之后，会自动完成一个 channel 最后的清理工作，无需再调用 `deregister` 方法。

```java
private void fireChannelInactiveAndDeregister(final boolean wasActive) {
    deregister(voidPromise(), wasActive && !isActive());
}
```

## Channel#deregister

`deregister`的调用栈

```java
io.netty.channel.AbstractChannel#deregister()
io.netty.channel.DefaultChannelPipeline#deregister()
io.netty.channel.AbstractChannelHandlerContext#deregister()
io.netty.channel.AbstractChannelHandlerContext#deregister(io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannelHandlerContext#invokeDeregister
io.netty.channel.DefaultChannelPipeline.HeadContext#deregister
io.netty.channel.AbstractChannel.AbstractUnsafe#deregister(io.netty.channel.ChannelPromise)
io.netty.channel.AbstractChannel.AbstractUnsafe#deregister(io.netty.channel.ChannelPromise, boolean)
io.netty.channel.nio.AbstractNioChannel#doDeregister
```

`deregister` 的逻辑在 `io.netty.channel.AbstractChannel.AbstractUnsafe#deregister(final ChannelPromise promise, final boolean fireChannelInactive)` 方法中实现。这个方法的实现比较简单，主要是调用 `doDeregister` 方法执行 `deregister` 操作，然后根据 `fireChannelInactive` 参数的值，触发 `channelInactive` 事件（如果 `fireChannelInactive` 为 `true`）以及 `channelUnregistered` 事件。

```java
private void deregister(final ChannelPromise promise, final boolean fireChannelInactive) {
    if (!promise.setUncancellable()) {
        return;
    }
    if (!registered) {
        safeSetSuccess(promise);
        return;
    }
    invokeLater(new Runnable() {
        @Override
        public void run() {
            try {
                doDeregister();
            } catch (Throwable t) {
                logger.warn("Unexpected exception occurred while deregistering a channel.", t);
            } finally {
                if (fireChannelInactive) {
                    pipeline.fireChannelInactive();
                }
                if (registered) {
                    registered = false;
                    pipeline.fireChannelUnregistered();
                }
                safeSetSuccess(promise);
            }
        }
    });
}
```

这里使用 `invokeLater` 执行主要逻辑的目的是为了确保当前在 `eventLoop` 队列中的所有任务都执行完之后，再执行真正的 `deregister` 操作。

`doDeregister` 的默认实现是空的，不执行任何操作，它是一个 `protected` 方法。真正的实现位于 `io.netty.channel.nio.AbstractNioChannel` 中，具体做法是调用 `eventLoop` 的 `cancel` 方法，删除 `SocketChannel` 对应的 `SelectionKey` 从 `Selector` 中。这样，`Selector` 就不会再监听到该 `socket` 上的任何事件。

```java
@Override
protected void doDeregister() throws Exception {
    eventLoop().cancel(selectionKey());
}
```



## 总结

Netty 的 `channel` 继承体系到这里已经完成。相信现在从 `NioServerEventLoop` 入手，查看它的初始化过程应该会显得非常简单了。以下是我希望自己牢记的几个要点：

- `AbstractChannel` 维护 `NioChannel` 的 `EventLoop`。
- `AbstractNioChannel` 维护 JDK 原生的 `channel`。
- `AbstractChannel` 中的 `AbstractUnsafe`主要定义了一套模板，提供了以下三个填空供子类实现：
  - **注册**：将 `channel` 注册到 `Selector` 中。
  - **绑定**：将 `channel` 绑定到指定端口。
  - **添加感兴趣的事件**：为创建的 `channel` 二次注册 Netty 能处理的感兴趣的事件。

`channel` 的 I/O 操作由 `unsafe` 内部类完成：

- 服务端从 `channel` 读取出新的连接：`NioMessageUnsafe`。
- 客户端从 `channel` 读取出数据：`NioByteUnsafe`。