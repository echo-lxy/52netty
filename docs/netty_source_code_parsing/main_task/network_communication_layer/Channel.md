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

## Channel#Read

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

## AttributeMap 接口

```java
/**
 * Holds {@link Attribute}s which can be accessed via {@link AttributeKey}.
 *
 * Implementations must be Thread-safe.
 */
public interface AttributeMap {
    /**
     * Get the {@link Attribute} for the given {@link AttributeKey}. This method will never return null, but may return
     * an {@link Attribute} which does not have a value set yet.
     */
    <T> Attribute<T> attr(AttributeKey<T> key);

    /**
     * Returns {@code true} if and only if the given {@link Attribute} exists in this {@link AttributeMap}.
     */
    <T> boolean hasAttr(AttributeKey<T> key);
}
```

## DefaultAttributeMap 抽象类

【TODO】

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