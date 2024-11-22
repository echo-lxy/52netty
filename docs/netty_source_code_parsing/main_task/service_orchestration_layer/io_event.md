# 货物：被传播的 IO 事件

在前面的系列文章中，笔者多次介绍过，Netty 中的 I/O 事件主要分为两大类：inbound 类事件和 outbound 类事件。严格来说，应该分为三类，第三类是 `exceptionCaught` 异常事件类型。

实际上，`exceptionCaught` 事件在事件传播的角度上，和 inbound 类事件类似，都是从 `pipeline` 的 `HeadContext` 开始，一直向后传递，或者从当前的 `ChannelHandler` 开始，一直向后传递，直到 `TailContext`。因此，通常也会将 `exceptionCaught` 事件归为 inbound 类事件。

根据事件类型的分类，负责处理这些事件回调的 `ChannelHandler` 也分为两类：

- **`ChannelInboundHandler`** ：主要负责处理 inbound 类事件回调以及 `exceptionCaught` 事件回调。
- **`ChannelOutboundHandler`** ：主要负责处理 outbound 类事件回调。

那么，常见的 inbound 类事件和 outbound 类事件具体包括哪些呢？

## inbound 类事件

```java
final class ChannelHandlerMask {

    // inbound 事件集合
    static final int MASK_ONLY_INBOUND =  MASK_CHANNEL_REGISTERED |
            MASK_CHANNEL_UNREGISTERED | MASK_CHANNEL_ACTIVE | MASK_CHANNEL_INACTIVE | MASK_CHANNEL_READ |
            MASK_CHANNEL_READ_COMPLETE | MASK_USER_EVENT_TRIGGERED | MASK_CHANNEL_WRITABILITY_CHANGED;

    private static final int MASK_ALL_INBOUND = MASK_EXCEPTION_CAUGHT | MASK_ONLY_INBOUND;

    // inbound 类事件相关掩码
    static final int MASK_EXCEPTION_CAUGHT = 1;
    static final int MASK_CHANNEL_REGISTERED = 1 << 1;
    static final int MASK_CHANNEL_UNREGISTERED = 1 << 2;
    static final int MASK_CHANNEL_ACTIVE = 1 << 3;
    static final int MASK_CHANNEL_INACTIVE = 1 << 4;
    static final int MASK_CHANNEL_READ = 1 << 5;
    static final int MASK_CHANNEL_READ_COMPLETE = 1 << 6;
    static final int MASK_USER_EVENT_TRIGGERED = 1 << 7;
    static final int MASK_CHANNEL_WRITABILITY_CHANGED = 1 << 8;

}
```

Netty 会将其支持的所有异步事件用掩码来表示，这些掩码定义在 `ChannelHandlerMask` 类中。Netty 框架通过这些事件掩码可以很方便地知道用户自定义的 `ChannelHandler` 属于什么类型（`ChannelInboundHandler` 或 `ChannelOutboundHandler`）。

除此之外，`inbound` 类事件如此之多，用户并不是对所有的 `inbound` 类事件感兴趣。用户可以在自定义的 `ChannelInboundHandler` 中覆盖自己感兴趣的 `inbound` 事件回调，从而实现对特定 `inbound` 事件的监听。

这些用户感兴趣的 `inbound` 事件集合同样会用掩码的形式保存在自定义 `ChannelHandler` 对应的 `ChannelHandlerContext` 中。这样，当特定的 `inbound` 事件在 pipeline 中开始传播时，Netty 可以根据对应的 `ChannelHandlerContext` 中保存的 `inbound` 事件集合掩码来判断用户自定义的 `ChannelHandler` 是否对该 `inbound` 事件感兴趣，从而决定是否执行用户自定义 `ChannelHandler` 中的相应回调方法，或者跳过对该 `inbound` 事件不感兴趣的 `ChannelHandler`，继续向后传播。

从以上描述中，我们也可以窥探出，Netty 引入 `ChannelHandlerContext` 来封装 `ChannelHandler` 的原因。代码设计上依然遵循单一职责的原则。`ChannelHandler` 是用户接触最频繁的一个 Netty 组件，Netty 希望用户能够将全部注意力集中在最核心的 IO 处理上。用户只需要关心自己对哪些异步事件感兴趣，并考虑相应的处理逻辑即可，而不必关心异步事件在 pipeline 中如何传递，如何选择具有执行条件的 `ChannelHandler` 去执行或跳过。这样的切面性质的逻辑，Netty 将它们作为上下文信息封装在 `ChannelHandlerContext` 中，由 Netty 框架本身负责处理。

以上内容我将在事件传播相关的小节中做详细介绍，之所以在此引出，是为了让大家感受下利用掩码进行集合操作的便利性。Netty 中类似这样的设计还有很多，例如前文系列文章中多次提到的，在 `channel` 向 reactor 注册 IO 事件时，Netty 也是将 `channel` 感兴趣的 IO 事件用掩码的形式存储于 `SelectionKey` 中的 `int interestOps` 字段。

接下来，我将为大家介绍这些 `inbound` 事件，并梳理出这些事件的触发时机，方便大家根据各自的业务需求灵活地进行监听。

### ExceptionCaught 事件

在本小节介绍的这些 `inbound` 类事件在 pipeline 中传播的过程中，如果在相应事件回调函数执行时发生异常，那么就会触发对应 `ChannelHandler` 中的 `exceptionCaught` 事件回调。

```java
private void invokeExceptionCaught(final Throwable cause) {
    if (invokeHandler()) {
        try {
            handler().exceptionCaught(this, cause);
        } catch (Throwable error) {
            if (logger.isDebugEnabled()) {
                logger.debug(
                    "An exception {}" +
                    "was thrown by a user handler's exceptionCaught() " +
                    "method while handling the following exception:",
                    ThrowableUtil.stackTraceToString(error), cause);
            } else if (logger.isWarnEnabled()) {
                logger.warn(
                    "An exception '{}' [enable DEBUG level for full stacktrace] " +
                    "was thrown by a user handler's exceptionCaught() " +
                    "method while handling the following exception:", error, cause);
            }
        }
    } else {
        fireExceptionCaught(cause);
    }
}
```

当然，用户可以选择在 `exceptionCaught` 事件回调中是否执行 `ctx.fireExceptionCaught(cause)`，从而决定是否将 `exceptionCaught` 事件继续向后传播。

```java
@Override
public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
    ..........
    ctx.fireExceptionCaught(cause);
}
```

当 Netty 内核处理连接的接收以及数据的读取过程中，如果发生异常，会在整个 pipeline 中触发 `exceptionCaught` 事件的传播。

**为什么要单独强调在 `inbound` 事件传播的过程中发生异常，才会回调 `exceptionCaught` 呢？**

因为 `inbound` 事件一般是由 Netty 内核触发并传播的，而 `outbound` 事件通常由用户选择触发。例如，用户在处理完业务逻辑后，触发的 `write` 事件或 `flush` 事件。

在用户触发 `outbound` 事件后，通常会得到一个 `ChannelPromise`。用户可以向 `ChannelPromise` 添加各种 listener。当 `outbound` 事件在传播过程中发生异常时，Netty 会通知用户持有的 `ChannelPromise`，**但不会触发 `exceptionCaught` 的回调**。

例如，在我们[《处理 OP_WRITE 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_WRITE)一文中提到的，`write` 事件传播过程中并不会触发 `exceptionCaught` 事件回调，而只是通知用户的 `ChannelPromise`。

```java
private void invokeWrite0(Object msg, ChannelPromise promise) {
    try {
        //调用当前ChannelHandler中的write方法
        ((ChannelOutboundHandler) handler()).write(this, msg, promise);
    } catch (Throwable t) {
        notifyOutboundHandlerException(t, promise);
    }
}

private static void notifyOutboundHandlerException(Throwable cause, ChannelPromise promise) {
    PromiseNotificationUtil.tryFailure(promise, cause, promise instanceof VoidChannelPromise ? null : logger);
}
```

`outbound` 事件中，**只有 `flush` 事件的传播是个例外**。当 `flush` 事件在 pipeline 传播过程中发生异常时，会触发对应异常 `ChannelHandler` 的 `exceptionCaught` 事件回调。这是因为 `flush` 方法的签名中不会返回 `ChannelPromise` 给用户。

```java
@Override
ChannelHandlerContext flush();
private void invokeFlush0() {
    try {
        ((ChannelOutboundHandler) handler()).flush(this);
    } catch (Throwable t) {
        invokeExceptionCaught(t);
    }
}
```

### ChannelRegistered 事件

当 main reactor 启动时，`NioServerSocketChannel` 会被创建并初始化，随后会向 main reactor 注册。注册成功后，`ChannelRegistered` 事件会在 `NioServerSocketChannel` 的 pipeline 中传播。

当 main reactor 接收到客户端发起的连接后，`NioSocketChannel` 会被创建并初始化，随后会向 sub reactor 注册。注册成功后，`ChannelRegistered` 事件会在 `NioSocketChannel` 的 pipeline 中传播。

![image-20241122111005382](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411221110455.png)

```java
private void register0(ChannelPromise promise) {

    ................
    //执行真正的注册操作
    doRegister();

    ...........

    //触发channelRegister事件
    pipeline.fireChannelRegistered();

    .......
}
```

注意：此时对应的 `channel` 还没有将 IO 事件注册到相应的 reactor 中。

### ChannelActive 事件

当 `NioServerSocketChannel` 向 main reactor 注册成功并触发 `ChannelRegistered` 事件传播后，接着会在 pipeline 中触发 `bind` 事件。`bind` 事件是一个 `outbound` 事件，它会从 pipeline 中的尾节点 `TailContext` 一直向前传播，最终在 `HeadContext` 中执行真正的绑定操作。

```java
@Override
public void bind(
        ChannelHandlerContext ctx, SocketAddress localAddress, ChannelPromise promise) {
    //触发AbstractChannel->bind方法 执行JDK NIO SelectableChannel 执行底层绑定操作
    unsafe.bind(localAddress, promise);
}
@Override
public final void bind(final SocketAddress localAddress, final ChannelPromise promise) {
     ..............

    doBind(localAddress);

    ...............

    //绑定成功后 channel激活 触发channelActive事件传播
    if (!wasActive && isActive()) {
        invokeLater(new Runnable() {
            @Override
            public void run() {
                //HeadContext->channelActive回调方法 执行注册OP_ACCEPT事件
                pipeline.fireChannelActive();
            }
        });
    }

    ...............
}
```

当 Netty 服务端的 `NioServerSocketChannel` 绑定端口成功后，才算真正的 **Active**，随后触发 `ChannelActive` 事件在 pipeline 中传播。

之前我们也提到过，判断 `NioServerSocketChannel` 是否 **Active** 的标准是：**底层 JDK 的 `ServerSocketChannel` 是否 open，并且 `ServerSocket` 是否已经完成绑定**。

```java
@Override
public boolean isActive() {
    return isOpen() && javaChannel().socket().isBound();
}
```

而客户端的 `NioSocketChannel` 中触发 `ChannelActive` 事件相对简单。当 `NioSocketChannel` 向 sub reactor 注册成功并触发 `ChannelRegistered` 事件后，紧接着就会触发 `ChannelActive` 事件，并在 pipeline 中传播。

```java
private void register0(ChannelPromise promise) {

    ................
    //执行真正的注册操作
    doRegister();

    ...........

    //触发channelRegister事件
    pipeline.fireChannelRegistered();

    .......

    if (isActive()) {

            if (firstRegistration) {
                //触发channelActive事件
                pipeline.fireChannelActive();
            } else if (config().isAutoRead()) {
                beginRead();
            }
      }
}
```

客户端 `NioSocketChannel` 是否 **Active** 的标识是：底层 JDK `SocketChannel` 是否 open，并且底层 `socket` 是否连接。毫无疑问，这里的 `socket` 一定是 **connected**，因此直接触发 `ChannelActive` 事件。

```java
@Override
public boolean isActive() {
    SocketChannel ch = javaChannel();
    return ch.isOpen() && ch.isConnected();
}
```

注意：此时 `channel` 才会在相应的 reactor 中注册感兴趣的 IO 事件。当用户自定义的 `ChannelHandler` 接收到 `ChannelActive` 事件时，表明 IO 事件已经注册到 reactor 中了。

### ChannelRead 和 ChannelReadComplete 事件

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311647424.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_ne,x_1,y_1" alt="image-20241031164720178" style="zoom: 25%;" />

当客户端发起新连接请求时，服务端的 `NioServerSocketChannel` 上的 `OP_ACCEPT` 事件会被激活，随后 main reactor 会在一个 read loop 中不断调用 `serverSocketChannel.accept()` 接收新的连接，直到全部连接接收完毕或达到 read loop 最大次数（16 次）。

在 `NioServerSocketChannel` 中，每接受一个新的连接，都会在 pipeline 中触发 `ChannelRead` 事件。一个完整的 read loop 结束后，会触发 `ChannelReadComplete` 事件。

```java
private final class NioMessageUnsafe extends AbstractNioUnsafe {

    @Override
    public void read() {
        ......................


            try {
                do {
                    //底层调用NioServerSocketChannel->doReadMessages 创建客户端SocketChannel
                    int localRead = doReadMessages(readBuf);
                    .................
                } while (allocHandle.continueReading());

            } catch (Throwable t) {
                exception = t;
            }

            int size = readBuf.size();
            for (int i = 0; i < size; i ++) {            
                pipeline.fireChannelRead(readBuf.get(i));
            }

            pipeline.fireChannelReadComplete();

                 .................
    }
}
```

当客户端的 `NioSocketChannel` 上有请求数据到来时，`OP_READ` 事件会被激活，随后 sub reactor 会在一个 read loop 中对 `NioSocketChannel` 中的请求数据进行读取，直到读取完毕或达到 read loop 的最大次数（16 次）。

在 read loop 的读取过程中，每读取一次数据，就会在 pipeline 中触发 `ChannelRead` 事件。当一个完整的 read loop 结束后，会在 pipeline 中触发 `ChannelReadComplete` 事件。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311703437.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_ne,x_1,y_1" alt="image-20241031170318065" style="zoom:25%;" />

**需要注意的是，当 `ChannelReadComplete` 事件触发时，并不意味着 `NioSocketChannel` 中的请求数据已经完全读取完毕**。可能的情况是发送的请求数据过多，导致在一个 read loop 中未能读取完毕，达到了最大限制次数（16 次）后退出了 read loop。即使数据未完全读取，退出 read loop 后仍会触发 `ChannelReadComplete` 事件。详细内容可以查看笔者的文章：[《处理 OP_READ 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_READ)。

### ChannelWritabilityChanged 事件

当我们处理完业务逻辑并得到处理结果后，会调用 `ctx.write(msg)`，触发 `write` 事件在 pipeline 中传播。

```java
@Override
public void channelRead(final ChannelHandlerContext ctx, final Object msg) {
     ctx.write(msg);
}
```

最终，Netty 会将发送数据 `msg` 写入 `NioSocketChannel` 中的待发送缓冲队列 `ChannelOutboundBuffer`，并等待用户调用 `flush` 操作，将待发送数据从 `ChannelOutboundBuffer` 写入到底层 `Socket` 的发送缓冲区中。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311801283.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031180100928" style="zoom: 33%;" />

当对端的接收处理速度非常慢或网络状况极度拥塞时，导致 TCP 滑动窗口不断缩小，这会使得发送端的发送速度变得越来越慢。此时，如果用户仍然不断调用 `ctx.write(msg)`，`ChannelOutboundBuffer` 会急剧增大，最终可能导致 OOM（内存溢出）。为了解决这个问题，Netty 引入了高低水位线来控制 `ChannelOutboundBuffer` 的内存占用。

```java
public final class WriteBufferWaterMark {

    private static final int DEFAULT_LOW_WATER_MARK = 32 * 1024;
    private static final int DEFAULT_HIGH_WATER_MARK = 64 * 1024;
}
```

当 `ChannelOutboundBuffer` 中的内存占用超过高水位线时，Netty 会将对应的 `channel` 置为不可写状态，并在 pipeline 中触发 `ChannelWritabilityChanged` 事件。

```java
private void setUnwritable(boolean invokeLater) {
    for (;;) {
        final int oldValue = unwritable;
        final int newValue = oldValue | 1;
        if (UNWRITABLE_UPDATER.compareAndSet(this, oldValue, newValue)) {
            if (oldValue == 0) {
                //触发fireChannelWritabilityChanged事件 表示当前channel变为不可写
                fireChannelWritabilityChanged(invokeLater);
            }
            break;
        }
    }
}
```

当 `ChannelOutboundBuffer` 中的内存占用低于低水位线时，Netty 会将对应的 `NioSocketChannel` 设置为可写状态，并再次触发 `ChannelWritabilityChanged` 事件。

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729744690440-9d35239d-4bb5-44e3-88ee-85eea72075de.png)

```java
private void setWritable(boolean invokeLater) {
    for (;;) {
        final int oldValue = unwritable;
        final int newValue = oldValue & ~1;
        if (UNWRITABLE_UPDATER.compareAndSet(this, oldValue, newValue)) {
            if (oldValue != 0 && newValue == 0) {
                fireChannelWritabilityChanged(invokeLater);
            }
            break;
        }
    }
}
```

用户可以在自定义 `ChannelHandler` 中通过 `ctx.channel().isWritable()` 判断当前 `channel` 是否可写。

```java
@Override
public void channelWritabilityChanged(ChannelHandlerContext ctx) throws Exception {

    if (ctx.channel().isWritable()) {
        ...........当前channel可写.........
    } else {
        ...........当前channel不可写.........
    }
}
```

### UserEventTriggered 事件

Netty 提供了一种事件扩展机制，允许用户自定义异步事件。这使得用户能够灵活地定义各种复杂场景的处理机制。

接下来，我们来看看如何在 Netty 中自定义异步事件。

```java
public final class OurOwnDefinedEvent {
 
    public static final OurOwnDefinedEvent INSTANCE = new OurOwnDefinedEvent();

    private OurOwnDefinedEvent() { }
}
public class EchoServerHandler extends ChannelInboundHandlerAdapter {

    @Override
    public void channelRead(final ChannelHandlerContext ctx, final Object msg) {
            ......省略.......
            //事件在pipeline中从当前ChannelHandlerContext开始向后传播
            ctx.fireUserEventTriggered(OurOwnDefinedEvent.INSTANCE);
            //事件从pipeline的头结点headContext开始向后传播
            ctx.channel().pipeline().fireUserEventTriggered(OurOwnDefinedEvent.INSTANCE);

    }
}
public class EchoServerHandler extends ChannelInboundHandlerAdapter {

    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {

        if (OurOwnDefinedEvent.INSTANCE == evt) {
              .....自定义事件处理......
        }
    }

}
```

随着我们深入解读源码，你将发现 Netty 自身也定义了许多 `UserEvent` 事件。我们后续会进一步介绍这些事件，大家目前只需要对其基本用法有所了解即可。

### ChannelInactive和ChannelUnregistered事件

当 `Channel` 被关闭后，pipeline 中会首先触发 `ChannelInactive` 事件的传播，随后触发 `ChannelUnregistered` 事件的传播。

我们可以在 Inbound 类型的 `ChannelHandler` 中响应 `ChannelInactive` 和 `ChannelUnregistered` 事件。

```java
@Override
public void channelInactive(ChannelHandlerContext ctx) throws Exception {
    
    ......响应inActive事件...
    
    //继续向后传播inActive事件
    super.channelInactive(ctx);
}

@Override
public void channelUnregistered(ChannelHandlerContext ctx) throws Exception {
    
      ......响应Unregistered事件...

    //继续向后传播Unregistered事件
    super.channelUnregistered(ctx);
}
```

这里与连接建立后的事件触发顺序正好相反。连接建立时，首先触发 `ChannelRegistered` 事件，然后触发 `ChannelActive` 事件。

## Outbound 类事件

```java
final class ChannelHandlerMask {

    // outbound 事件的集合
    static final int MASK_ONLY_OUTBOUND =  MASK_BIND | MASK_CONNECT | MASK_DISCONNECT |
            MASK_CLOSE | MASK_DEREGISTER | MASK_READ | MASK_WRITE | MASK_FLUSH;

    private static final int MASK_ALL_OUTBOUND = MASK_EXCEPTION_CAUGHT | MASK_ONLY_OUTBOUND;
    
    // outbound 事件掩码
    static final int MASK_BIND = 1 << 9;
    static final int MASK_CONNECT = 1 << 10;
    static final int MASK_DISCONNECT = 1 << 11;
    static final int MASK_CLOSE = 1 << 12;
    static final int MASK_DEREGISTER = 1 << 13;
    static final int MASK_READ = 1 << 14;
    static final int MASK_WRITE = 1 << 15;
    static final int MASK_FLUSH = 1 << 16;
}
```

与 Inbound 类事件类似，Outbound 类事件也有对应的掩码表示。接下来，我们来看看 Outbound 类事件的触发时机：

### read 事件

**需要注意区分 `read` 事件和 `ChannelRead` 事件的不同**。

`ChannelRead` 事件我们之前已经介绍过。当 `NioServerSocketChannel` 接收到新连接时，会触发 `ChannelRead` 事件在其 pipeline 上传播。当 `NioSocketChannel` 上有请求数据时，在 read loop 中读取数据时，也会触发 `ChannelRead` 事件在其 pipeline 上传播。

而 `read` 事件与 `ChannelRead` 事件完全不同。`read` 事件特指使 `Channel` 具备感知 IO 事件的能力。例如，`NioServerSocketChannel` 对应的 `OP_ACCEPT` 事件的感知能力，`NioSocketChannel` 对应的是 `OP_READ` 事件的感知能力。

`read` 事件的触发发生在 `Channel` 需要向其对应的 reactor 注册读类型事件时（如 `OP_ACCEPT` 事件和 `OP_READ` 事件）。`read` 事件的响应就是将 `Channel` 感兴趣的 IO 事件注册到对应的 reactor 上。例如，`NioServerSocketChannel` 感兴趣的是 `OP_ACCEPT` 事件，`NioSocketChannel` 感兴趣的是 `OP_READ` 事件。

我们在之前介绍 `ChannelActive` 事件时提到，当 `Channel` 处于 active 状态后，会在 pipeline 中传播 `ChannelActive` 事件。在 `HeadContext` 中的 `ChannelActive` 事件回调中，会触发 `read` 事件的传播。

```java
final class HeadContext extends AbstractChannelHandlerContext
        implements ChannelOutboundHandler, ChannelInboundHandler {

    @Override
    public void channelActive(ChannelHandlerContext ctx) {
        ctx.fireChannelActive();  
        readIfIsAutoRead();
    }

    private void readIfIsAutoRead() {
        if (channel.config().isAutoRead()) {
            //如果是autoRead 则触发read事件传播
            channel.read();
        }
    }

    @Override
    public void read(ChannelHandlerContext ctx) {
        //触发注册OP_ACCEPT或者OP_READ事件
        unsafe.beginRead();
    }
}
```

而在 `HeadContext` 中的 `read` 事件回调中，会调用 `Channel` 的底层操作类 `unsafe` 的 `beginRead` 方法。在该方法中，会向 reactor 注册 `Channel` 感兴趣的 IO 事件。对于 `NioServerSocketChannel` 来说，这里注册的是 `OP_ACCEPT` 事件；对于 `NioSocketChannel` 来说，注册的是 `OP_READ` 事件。

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
        //注册监听OP_ACCEPT或者OP_READ事件
        selectionKey.interestOps(interestOps | readInterestOp);
    }
}
```

**细心的同学可能注意到，`Channel` 对应的配置类中包含了一个 `autoRead` 属性，那么这个 `autoRead` 究竟是做什么的呢？**

实际上，这是 Netty 提供的一种背压机制，用来防止 OOM（内存溢出）。假设对端发送的数据非常多，并且发送速度非常快，而服务端处理速度较慢，短时间内无法消费完所有数据。与此同时，对端仍然在大量发送数据，导致服务端的 reactor 线程不断在 read loop 中读取数据，并为读取到的数据分配 `ByteBuffer`。然而，服务端的业务线程处理不过来，未处理的数据堆积在内存中，最终可能导致 OOM。

为了解决这个问题，我们可以通过 `channelHandlerContext.channel().config().setAutoRead(false)` 将 `autoRead` 属性设置为 `false`。这样，Netty 会从 reactor 中注销 `Channel` 感兴趣的读类型事件，之后 reactor 就不会再监听相应的事件，导致 `Channel` 停止读取数据。

对于 `NioServerSocketChannel` 来说，对应的是 `OP_ACCEPT` 事件，而对于 `NioSocketChannel` 来说，对应的是 `OP_READ` 事件。

```java
protected final void removeReadOp() {
    SelectionKey key = selectionKey();
    if (!key.isValid()) {
        return;
    }
    int interestOps = key.interestOps();
    if ((interestOps & readInterestOp) != 0) {        
        key.interestOps(interestOps & ~readInterestOp);
    }
}
```

而当服务端的处理速度恢复正常时，我们可以通过 `channelHandlerContext.channel().config().setAutoRead(true)` 将 `autoRead` 属性重新设置为 `true`。这样，Netty 会在 pipeline 中触发 `read` 事件，最终在 `HeadContext` 中的 `read` 事件回调方法中，调用 `unsafe#beginRead` 方法，将 `Channel` 感兴趣的读类型事件重新注册到对应的 reactor 中。

```java
@Override
public ChannelConfig setAutoRead(boolean autoRead) {
    boolean oldAutoRead = AUTOREAD_UPDATER.getAndSet(this, autoRead ? 1 : 0) == 1;
    if (autoRead && !oldAutoRead) {
        //autoRead从false变为true
        channel.read();
    } else if (!autoRead && oldAutoRead) {
        //autoRead从true变为false
        autoReadCleared();
    }
    return this;
}
```

`read` 事件可以理解为赋予 `Channel` 读取数据的能力。当 `Channel` 拥有了读取能力后，`channelRead` 事件才能触发，进而读取具体的数据。

### write 和 flush 事件

`write` 事件和 `flush` 事件我们在[《处理 OP_WRITE 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_WRITE)一文中已做了详细介绍，接下来我们简单回顾一下。

`write` 事件和 `flush` 事件都是在用户处理完业务请求并获得业务结果后，由业务线程主动触发的。

用户可以通过 `ChannelHandlerContext` 或 `Channel` 来触发这两个事件。不同之处在于，如果通过 `ChannelHandlerContext` 触发，`write` 事件或 `flush` 事件将从当前 `ChannelHandler` 开始，一直向前传播，直到 `HeadContext`。

```java
@Override
public void channelRead(final ChannelHandlerContext ctx, final Object msg) {
   ctx.write(msg);
}

@Override
public void channelReadComplete(ChannelHandlerContext ctx) {
    ctx.flush();
}
```

如果通过 `Channel` 触发，`write` 事件和 `flush` 事件将从 pipeline 的尾部节点 `TailContext` 开始，向前传播直到 `HeadContext`。

```java
@Override
public void channelRead(final ChannelHandlerContext ctx, final Object msg) {
   ctx.channel().write(msg);
}

@Override
public void channelReadComplete(ChannelHandlerContext ctx) {
    ctx.channel().flush();
}
```

当然，还有一个 `writeAndFlush` 方法，这个方法会在 **ChannelHandlerContext** 或 **Channel** 中触发。触发 `writeAndFlush` 后，`write` 事件首先会在 pipeline 中传播，最后 `flush` 事件也会在 pipeline 中传播。

Netty 对 `write` 事件的处理最终会将发送的数据写入 `Channel` 对应的写缓冲队列 `ChannelOutboundBuffer` 中。在这一时刻，数据并没有被真正发送出去，而是被缓存于写缓冲队列中，这也是 Netty 实现异步写操作的核心设计。

最终，通过 `flush` 操作，从 `Channel` 中的写缓冲队列 `ChannelOutboundBuffer` 中获取待发送的数据，并将其写入到 Socket 的发送缓冲区中。

### close 事件

当用户在 `ChannelHandler` 中调用如下方法关闭 `Channel` 时，会触发 **Close** 事件，并且该事件会在 pipeline 中从后向前传播。

```java
//close事件从当前ChannelHandlerContext开始在pipeline中向前传播
ctx.close();
//close事件从pipeline的尾结点tailContext开始向前传播
ctx.channel().close();
```

我们可以在 **Outbound** 类型的 `ChannelHandler` 中响应 **close** 事件。

```java
public class ExampleChannelHandler extends ChannelOutboundHandlerAdapter {

    @Override
    public void close(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception {
        
        .....客户端channel关闭之前的处理回调.....
        
        //继续向前传播close事件
        super.close(ctx, promise);
    }
}
```

最终，`close` 事件会在 pipeline 中一直向前传播，直到头结点 `HeadConnect` 中，并在 `HeadContext` 中完成连接关闭的操作。当连接完成关闭之后，`ChannelInactive` 事件和 `ChannelUnregistered` 事件会依次在 pipeline 中触发。

### deRegister 事件

用户可以调用如下代码将当前 `Channel` 从 Reactor 中注销：

```java
//deregister事件从当前ChannelHandlerContext开始在pipeline中向前传播
ctx.deregister();
//deregister事件从pipeline的尾结点tailContext开始向前传播
ctx.channel().deregister();
```

我们可以在 `Outbound` 类型的 `ChannelHandler` 中响应 `deregister` 事件。

```java
public class ExampleChannelHandler extends ChannelOutboundHandlerAdapter {

    @Override
    public void deregister(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception {


        .....客户端channel取消注册之前的处理回调.....

        //继续向前传播connect事件
        super.deregister(ctx, promise);
    }
}
```

最终，`deregister` 事件会传播至 pipeline 中的头结点 `HeadContext` 中，并在 `HeadContext` 中完成底层 `Channel` 取消注册的操作。当 `Channel` 从 Reactor 上注销之后，Reactor 将不再监听该 `Channel` 上的 IO 事件，并触发 `ChannelUnregistered` 事件在 pipeline 中传播。

### connect 事件

在 Netty 的客户端中，我们可以利用 `NioSocketChannel` 的 `connect` 方法触发 `connect` 事件，并使其在 pipeline 中传播。

```java
//connect事件从当前ChannelHandlerContext开始在pipeline中向前传播
ctx.connect(remoteAddress);
//connect事件从pipeline的尾结点tailContext开始向前传播
ctx.channel().connect(remoteAddress);
```

我们可以在 `Outbound` 类型的 `ChannelHandler` 中响应 `connect` 事件。

```java
public class ExampleChannelHandler extends ChannelOutboundHandlerAdapter {

    @Override
    public void connect(ChannelHandlerContext ctx, SocketAddress remoteAddress, SocketAddress localAddress,
                        ChannelPromise promise) throws Exception {
                 
        
        .....客户端channel连接成功之前的处理回调.....
        
        //继续向前传播connect事件
        super.connect(ctx, remoteAddress, localAddress, promise);
    }
}
```

最终，`connect` 事件会在 pipeline 中的头结点 `headContext` 中触发底层的连接建立请求。当客户端成功连接到服务端之后，`channelActive` 事件会在客户端 `NioSocketChannel` 的 pipeline 中传播。

### disConnect 事件

在 Netty 的客户端中，我们也可以调用 `NioSocketChannel` 的 `disconnect` 方法，在 pipeline 中触发 `disconnect` 事件，这会导致 `NioSocketChannel` 的关闭。

```java
//disconnect事件从当前ChannelHandlerContext开始在pipeline中向前传播
ctx.disconnect();
//disconnect事件从pipeline的尾结点tailContext开始向前传播
ctx.channel().disconnect();
```

我们可以在 `Outbound` 类型的 `ChannelHandler` 中响应 `disconnect` 事件。

```java
public class ExampleChannelHandler extends ChannelOutboundHandlerAdapter {


    @Override
    public void disconnect(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception {
        
        .....客户端channel即将关闭前的处理回调.....
        
        //继续向前传播disconnect事件
        super.disconnect(ctx, promise);
    }
}
```

最终，`disconnect` 事件会传播到 `HeadContext` 中，并在 `HeadContext` 中完成底层的断开连接操作。当客户端成功断开连接后，`ChannelInactive` 事件和 `ChannelUnregistered` 事件会依次在 pipeline 中触发。

## 事件传播

在本文开头，我们介绍了 Netty 事件类型共分为三大类，分别是 `Inbound` 类事件、`Outbound` 类事件和 `ExceptionCaught` 事件，并详细介绍了这三类事件的掩码表示、触发时机，以及事件传播的方向。

本小节将从源码角度分析事件在 Netty 中如何根据异步事件的分类在 pipeline 中进行传播。

### Inbound 事件的传播

在第一节中，我们介绍了所有的 `Inbound` 类事件，这些事件在 pipeline 中的传播逻辑和传播方向是相同的，唯一的区别在于执行的回调方法不同。

本小节我们将以 `ChannelRead` 事件的传播为例，说明 `Inbound` 类事件是如何在 pipeline 中进行传播的。

如第一节所提到的，在 `NioSocketChannel` 中，`ChannelRead` 事件的触发时机是在每一次 `read loop` 读取数据之后，在 pipeline 中触发的。

```java
do {
          ............               
    allocHandle.lastBytesRead(doReadBytes(byteBuf));

          ............

    // 在客户端NioSocketChannel的pipeline中触发ChannelRead事件
    pipeline.fireChannelRead(byteBuf);

} while (allocHandle.continueReading());
```

从这里可以看到，任何 `Inbound` 类事件在 pipeline 中的传播起点都是从 `HeadContext` 头结点开始的。

```java
public class DefaultChannelPipeline implements ChannelPipeline {

    @Override
    public final ChannelPipeline fireChannelRead(Object msg) {
        AbstractChannelHandlerContext.invokeChannelRead(head, msg);
        return this;
    }
    
                    .........
}
```

`ChannelRead` 事件从 `HeadContext` 开始在 pipeline 中传播，首先会回调 `HeadContext` 中的 `channelRead` 方法。

在执行 `ChannelHandler` 中的相应事件回调方法时，需要确保回调方法的执行是在指定的 `executor` 中进行的。

```java
static void invokeChannelRead(final AbstractChannelHandlerContext next, Object msg) {
    final Object m = next.pipeline.touch(ObjectUtil.checkNotNull(msg, "msg"), next);
    EventExecutor executor = next.executor();
    //需要保证channelRead事件回调在channelHandler指定的executor中进行
    if (executor.inEventLoop()) {
        next.invokeChannelRead(m);
    } else {
        executor.execute(new Runnable() {
            @Override
            public void run() {
                next.invokeChannelRead(m);
            }
        });
    }
}

private void invokeChannelRead(Object msg) {
    if (invokeHandler()) {
        try {
            ((ChannelInboundHandler) handler()).channelRead(this, msg);
        } catch (Throwable t) {
            invokeExceptionCaught(t);
        }
    } else {
        fireChannelRead(msg);
    }
}
```

在执行 `HeadContext` 的 `channelRead` 方法时，如果发生异常，会回调 `HeadContext` 的 `exceptionCaught` 方法。然后，在相应的事件回调方法中，会决定是否将事件继续在 pipeline 中传播。

```java
final class HeadContext extends AbstractChannelHandlerContext
    implements ChannelOutboundHandler, ChannelInboundHandler {

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        ctx.fireChannelRead(msg);
    }
    
    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        ctx.fireExceptionCaught(cause);
    }
}
```

在 `HeadContext` 中，通过 `ctx.fireChannelRead(msg)` 继续将 `ChannelRead` 事件在 pipeline 中向后传播。

```java
abstract class AbstractChannelHandlerContext implements ChannelHandlerContext, ResourceLeakHint {

    @Override
    public ChannelHandlerContext fireChannelRead(final Object msg) {
        invokeChannelRead(findContextInbound(MASK_CHANNEL_READ), msg);
        return this;
    }

}
```

这里的 **`findContextInbound` 方法是整个 `Inbound` 类事件在 pipeline 中传播的核心所在**。

因为我们需要继续将 `ChannelRead` 事件在 pipeline 中传播，所以目前的核心问题是通过 `findContextInbound` 方法在 pipeline 中找到下一个对 `ChannelRead` 事件感兴趣的 `ChannelInboundHandler`。然后，执行该 `ChannelInboundHandler` 的 `ChannelRead` 事件回调。

```java
static void invokeChannelRead(final AbstractChannelHandlerContext next, Object msg) {
    final Object m = next.pipeline.touch(ObjectUtil.checkNotNull(msg, "msg"), next);
    EventExecutor executor = next.executor();
    //需要保证channelRead事件回调在channelHandler指定的executor中进行
    if (executor.inEventLoop()) {
        next.invokeChannelRead(m);
    } else {
        executor.execute(new Runnable() {
            @Override
            public void run() {
                next.invokeChannelRead(m);
            }
        });
    }
}
```

`ChannelRead` 事件就这样循环往复地在 pipeline 中传播，在传播的过程中，只有对 `ChannelRead` 事件感兴趣的 `ChannelInboundHandler` 才会响应。其他类型的 `ChannelHandler` 会直接跳过。

如果 `ChannelRead` 事件在 pipeline 中传播的过程中，没有得到其他 `ChannelInboundHandler` 的有效处理，最终会被传播到 pipeline 的末尾 `TailContext` 中。在本文第二小节中，我们提到过，`TailContext` 对于 `Inbound` 事件的意义就是做兜底的处理。例如：打印日志、释放 `ByteBuffer` 等操作。

```java
final class TailContext extends AbstractChannelHandlerContext implements ChannelInboundHandler {

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
            onUnhandledInboundMessage(ctx, msg);
    }

    protected void onUnhandledInboundMessage(ChannelHandlerContext ctx, Object msg) {
        onUnhandledInboundMessage(msg);
        if (logger.isDebugEnabled()) {
            logger.debug("Discarded message pipeline : {}. Channel : {}.",
                         ctx.pipeline().names(), ctx.channel());
        }
    }

    protected void onUnhandledInboundMessage(Object msg) {
        try {
            logger.debug(
                    "Discarded inbound message {} that reached at the tail of the pipeline. " +
                            "Please check your pipeline configuration.", msg);
        } finally {
            // 释放DirectByteBuffer
            ReferenceCountUtil.release(msg);
        }
    }

}
```

### findContextInbound

本小节要介绍的 `findContextInbound` 方法和我们在上篇文章[《处理 OP_WRITE 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_WRITE)中介绍的 `findContextOutbound` 方法，均是 Netty 异步事件在 pipeline 中传播的核心所在。

事件传播的核心问题是需要高效地在 pipeline 中，根据事件的传播方向，找到下一个具有响应事件资格的 `ChannelHandler`。

例如：在这里我们传播的是 `ChannelRead` 事件，我们需要在 pipeline 中找到下一个对 `ChannelRead` 事件感兴趣的 `ChannelInboundHandler`，并执行该 `ChannelInboundHandler` 的 `ChannelRead` 事件回调。在 `ChannelRead` 事件回调中，我们可以对事件进行业务处理，并决定是否通过 `ctx.fireChannelRead(msg)` 将 `ChannelRead` 事件继续向后传播。

```java
private AbstractChannelHandlerContext findContextInbound(int mask) {
    AbstractChannelHandlerContext ctx = this;
    EventExecutor currentExecutor = executor();
    do {
        ctx = ctx.next;
    } while (skipContext(ctx, currentExecutor, mask, MASK_ONLY_INBOUND));

    return ctx;
}
```

参数 `mask` 表示我们正在传播的 `ChannelRead` 事件掩码 `MASK_CHANNEL_READ`。

```java
static final int MASK_EXCEPTION_CAUGHT = 1;
static final int MASK_CHANNEL_REGISTERED = 1 << 1;
static final int MASK_CHANNEL_UNREGISTERED = 1 << 2;
static final int MASK_CHANNEL_ACTIVE = 1 << 3;
static final int MASK_CHANNEL_INACTIVE = 1 << 4;
static final int MASK_CHANNEL_READ = 1 << 5;
static final int MASK_CHANNEL_READ_COMPLETE = 1 << 6;
static final int MASK_USER_EVENT_TRIGGERED = 1 << 7;
static final int MASK_CHANNEL_WRITABILITY_CHANGED = 1 << 8;
```

通过 `ctx = ctx.next`，在 pipeline 中找到下一个 `ChannelHandler`，并通过 `skipContext` 方法判断下一个 `ChannelHandler` 是否具有响应事件的资格。如果没有，则跳过并继续向后查找。

例如：如果下一个 `ChannelHandler` 是一个 `ChannelOutboundHandler`，或者下一个 `ChannelInboundHandler` 对 `ChannelRead` 事件不感兴趣，那么就会直接跳过该 `ChannelHandler`，继续查找下一个合适的处理器。

### skipContext

该方法主要用来判断下一个 `ChannelHandler` 是否具有 `mask` 代表的事件的响应资格。

```java
private static boolean skipContext(
        AbstractChannelHandlerContext ctx, EventExecutor currentExecutor, int mask, int onlyMask) {

    return (ctx.executionMask & (onlyMask | mask)) == 0 ||
            (ctx.executor() == currentExecutor && (ctx.executionMask & mask) == 0);
}
```

- 参数 `onlyMask` 表示我们需要查找的 `ChannelHandler` 类型。例如，在传播 `ChannelRead` 事件时，它是一个 `inbound` 类事件，因此必须由 `ChannelInboundHandler` 来响应处理，所以这里传入的 `onlyMask` 为 `MASK_ONLY_INBOUND`（`ChannelInboundHandler` 的掩码表示）。
- `ctx.executionMask` 我们已经在[《分拣操作台：ChannelHandlerContext》](/netty_source_code_parsing/main_task/service_orchestration_layer/ChannelHandlerContext)中详细介绍过。当 `ChannelHandler` 被添加进 pipeline 中时，系统会计算出该 `ChannelHandler` 感兴趣的事件集合掩码，并保存在对应 `ChannelHandlerContext` 的 `executionMask` 字段中。
- 首先，通过 `ctx.executionMask & (onlyMask | mask) == 0` 来判断下一个 `ChannelHandler` 的类型是否正确。例如，我们正在传播 `inbound` 类事件，如果下一个 `ChannelHandler` 是 `ChannelOutboundHandler`，那么肯定是要跳过的，继续向后查找。
- 如果下一个 `ChannelHandler` 的类型正确，系统会通过 `(ctx.executionMask & mask) == 0` 来判断该 `ChannelHandler` 是否对正在传播的 `mask` 事件感兴趣。如果该 `ChannelHandler` 覆盖了 `ChannelRead` 回调方法，则执行该回调；如果没有覆盖对应的事件回调方法，则跳过，继续向后查找，直到 `TailContext`。

以上就是 `skipContext` 方法的核心逻辑，表达的核心语义是：

- 如果 pipeline 中传播的是 `inbound` 类事件，则必须由 `ChannelInboundHandler` 来响应，并且该 `ChannelHandler` 必须覆盖实现对应的 `inbound` 事件回调。
- 如果 pipeline 中传播的是 `outbound` 类事件，则必须由 `ChannelOutboundHandler` 来响应，并且该 `ChannelHandler` 必须覆盖实现对应的 `outbound` 事件回调。

许多同学可能会对 `ctx.executor() == currentExecutor` 这个条件感到疑惑。实际上，加入这个条件对我们这里的核心语义并没有太大影响。

- 当 `ctx.executor() == currentExecutor` 时，表示前后两个 `ChannelHandler` 指定的 `executor` 相同，这时我们核心语义保持不变。
- 当 `ctx.executor() != currentExecutor` 时，表示前后两个 `ChannelHandler` 指定的 `executor` 不同，**语义变为：只要前后两个 `ChannelHandler` 指定的 `executor` 不同，不管下一个 `ChannelHandler` 是否覆盖实现指定事件的回调方法，都不能跳过**。在这种情况下，会执行 `ChannelHandler` 的默认事件回调方法，并继续在 pipeline 中传递事件。我们在[《分拣操作台：ChannelHandlerContext》](/netty_source_code_parsing/main_task/service_orchestration_layer/ChannelHandlerContext)中提到过，`ChannelInboundHandlerAdapter` 和 `ChannelOutboundHandlerAdapter` 会分别对 `inbound` 类事件回调方法和 `outbound` 类事件回调方法进行默认的实现。

```java
public class ChannelOutboundHandlerAdapter extends ChannelHandlerAdapter implements ChannelOutboundHandler {

    @Skip
    @Override
    public void bind(ChannelHandlerContext ctx, SocketAddress localAddress,
            ChannelPromise promise) throws Exception {
        ctx.bind(localAddress, promise);
    }

    @Skip
    @Override
    public void connect(ChannelHandlerContext ctx, SocketAddress remoteAddress,
            SocketAddress localAddress, ChannelPromise promise) throws Exception {
        ctx.connect(remoteAddress, localAddress, promise);
    }

    @Skip
    @Override
    public void disconnect(ChannelHandlerContext ctx, ChannelPromise promise)
            throws Exception {
        ctx.disconnect(promise);
    }

    @Skip
    @Override
    public void close(ChannelHandlerContext ctx, ChannelPromise promise)
            throws Exception {
        ctx.close(promise);
    }

    @Skip
    @Override
    public void deregister(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception {
        ctx.deregister(promise);
    }

    @Skip
    @Override
    public void read(ChannelHandlerContext ctx) throws Exception {
        ctx.read();
    }

    @Skip
    @Override
    public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) throws Exception {
        ctx.write(msg, promise);
    }

    @Skip
    @Override
    public void flush(ChannelHandlerContext ctx) throws Exception {
        ctx.flush();
    }
}
```

这里之所以需要加入 `ctx.executor() == currentExecutor` 条件的判断，是为了防止在 `HttpContentCompressor` 被指定不同的 `executor` 的情况下，无法正确创建压缩内容，进而导致一些异常。但这并不是本文的重点，大家只需要理解这里的核心语义即可。对于这种特殊情况的特殊处理，了解一下就好，不必过多关注。

### Outbound事件的传播

关于 Outbound 类事件的传播，笔者在上篇文章[《处理 OP_WRITE 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_WRITE)中已经进行了详细的介绍，本小节就不在赘述。

### ExceptionCaught事件的传播

最后，我们来介绍一下异常事件在 pipeline 中的传播。`ExceptionCaught` 事件和 `Inbound` 类事件一样，都是在 pipeline 中从前往后开始传播。

`ExceptionCaught` 事件的触发有两种情况：一种是 Netty 框架内部产生的异常，这时 Netty 会直接在 pipeline 中触发 `ExceptionCaught` 事件的传播。异常事件会从 `HeadContext` 开始，一直向后传播直到 `TailContext`。

举个例子，如果 Netty 在 `read loop` 中读取数据时发生异常：

```java
try {
       ...........

       do {
                  ............               
            allocHandle.lastBytesRead(doReadBytes(byteBuf));

                  ............

            //客户端NioSocketChannel的pipeline中触发ChannelRead事件
            pipeline.fireChannelRead(byteBuf);

        } while (allocHandle.continueReading());

                 ...........
}  catch (Throwable t) {
        handleReadException(pipeline, byteBuf, t, close, allocHandle);
} 
```

这时，Netty 会直接从 pipeline 中触发 `ExceptionCaught` 事件的传播。

```java
private void handleReadException(ChannelPipeline pipeline, ByteBuf byteBuf, Throwable cause, boolean close,
    RecvByteBufAllocator.Handle allocHandle) {
 
        .............

    pipeline.fireExceptionCaught(cause);
    
        .............

}
```

和 `Inbound` 类事件一样，`ExceptionCaught` 事件会在 pipeline 中从 `HeadContext` 开始，一直向后传播。

```java
@Override
public final ChannelPipeline fireExceptionCaught(Throwable cause) {
    AbstractChannelHandlerContext.invokeExceptionCaught(head, cause);
    return this;
}
```

第二种触发 `ExceptionCaught` 事件的情况是，当 `Inbound` 类事件或者 `flush` 事件在 pipeline 中传播的过程中，在某个 `ChannelHandler` 的事件回调方法处理中发生异常。这时，该 `ChannelHandler` 的 `exceptionCaught` 方法会被回调。用户可以在这里处理异常事件，并决定是否通过 `ctx.fireExceptionCaught(cause)` 继续向后传播异常事件。

例如，当我们在 `ChannelInboundHandler` 中的 `ChannelRead` 回调方法中处理业务请求时，如果发生异常，就会触发该 `ChannelInboundHandler` 的 `exceptionCaught` 方法。

```java
private void invokeChannelRead(Object msg) {
    if (invokeHandler()) {
        try {
            ((ChannelInboundHandler) handler()).channelRead(this, msg);
        } catch (Throwable t) {
            invokeExceptionCaught(t);
        }
    } else {
        fireChannelRead(msg);
    }
}
private void invokeExceptionCaught(final Throwable cause) {
    if (invokeHandler()) {
        try {
            //触发channelHandler的exceptionCaught回调
            handler().exceptionCaught(this, cause);
        } catch (Throwable error) {
              ........
    } else {
              ........
    }
}
```

再比如：当我们在 `ChannelOutboundHandler` 中的 `flush` 回调方法中处理业务结果发送时，如果发生异常，也会触发该 `ChannelOutboundHandler` 的 `exceptionCaught` 方法。

```java
private void invokeFlush0() {
    try {
        ((ChannelOutboundHandler) handler()).flush(this);
    } catch (Throwable t) {
        invokeExceptionCaught(t);
    }
}
```

我们可以在 `ChannelHandler` 的 `exceptionCaught` 回调中进行异常处理，并决定是否通过 `ctx.fireExceptionCaught(cause)` 继续向后传播异常事件。

```java
@Override
public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause)
        throws Exception {

    .........异常处理.......

    ctx.fireExceptionCaught(cause);
}
@Override
public ChannelHandlerContext fireExceptionCaught(final Throwable cause) {
    invokeExceptionCaught(findContextInbound(MASK_EXCEPTION_CAUGHT), cause);
    return this;
}

static void invokeExceptionCaught(final AbstractChannelHandlerContext next, final Throwable cause) {
    ObjectUtil.checkNotNull(cause, "cause");
    EventExecutor executor = next.executor();
    if (executor.inEventLoop()) {
        next.invokeExceptionCaught(cause);
    } else {
        try {
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    next.invokeExceptionCaught(cause);
                }
            });
        } catch (Throwable t) {
            if (logger.isWarnEnabled()) {
                logger.warn("Failed to submit an exceptionCaught() event.", t);
                logger.warn("The exceptionCaught() event that was failed to submit was:", cause);
            }
        }
    }
}
```

### ExceptionCaught 事件和 Inbound 类事件的区别

虽然 `ExceptionCaught` 事件和 `Inbound` 类事件在传播方向上都是在 pipeline 中从前向后传播，但这两者有一些重要的区别，大家需要注意区分。

- 在 `Inbound` 类事件传播过程中，会查找下一个具有事件响应资格的 `ChannelInboundHandler`。遇到 `ChannelOutboundHandler` 会直接跳过。
- 而 `ExceptionCaught` 事件无论是在 `ChannelInboundHandler` 还是 `ChannelOutboundHandler` 中触发，都会从当前触发异常的 `ChannelHandler` 开始，一直向后传播，且 `ChannelInboundHandler` 和 `ChannelOutboundHandler` 都可以响应该异常事件。

由于异常无论是在 `ChannelInboundHandler` 还是 `ChannelOutboundHandler` 中产生，`ExceptionCaught` 事件都会在 pipeline 中从前向后传播，并且不关心 `ChannelHandler` 的类型。因此，**我们通常将负责统一异常处理的 `ChannelHandler` 放在 pipeline 的最后**，这样它既能捕获 `inbound` 类异常，也能捕获 `outbound` 类异常。

![image-20241122110106362](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411221101492.png)

