# 货物：被传播的 IO 事件

在前边的系列文章中，笔者多次介绍过，Netty 中的 IO 事件一共分为两大类：inbound 类事件和 outbound 类事件。其实如果严格来分的话应该分为三类。第三种事件类型为 exceptionCaught 异常事件类型。

而 exceptionCaught 事件在事件传播角度上来说和 inbound 类事件一样，都是从 pipeline 的 HeadContext 开始一直向后传递或者从当前 ChannelHandler 开始一直向后传递直到 TailContext 。所以一般也会将 exceptionCaught 事件统一归为 inbound 类事件。

而根据事件类型的分类，相应负责处理事件回调的 ChannelHandler 也会被分为两类：

- `ChannelInboundHandler` ：主要负责响应处理 inbound 类事件回调和 exceptionCaught 事件回调。
- `ChannelOutboundHandler` ：主要负责响应处理 outbound 类事件回调。

那么我们常说的 inbound 类事件和 outbound 类事件具体都包含哪些事件呢？

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

netty 会将其支持的所有异步事件用掩码来表示，定义在 ChannelHandlerMask 类中， netty 框架通过这些事件掩码可以很方便的知道用户自定义的 ChannelHandler 是属于什么类型的（ChannelInboundHandler or ChannelOutboundHandler ）。

除此之外，inbound 类事件如此之多，用户也并不是对所有的 inbound 类事件感兴趣，用户可以在自定义的 ChannelInboundHandler 中覆盖自己感兴趣的 inbound 事件回调，从而达到针对特定 inbound 事件的监听。

这些用户感兴趣的 inbound 事件集合同样也会用掩码的形式保存在自定义 ChannelHandler 对应的 ChannelHandlerContext 中，这样当特定 inbound 事件在 pipeline 中开始传播的时候，netty 可以根据对应 ChannelHandlerContext 中保存的 inbound 事件集合掩码来判断，用户自定义的 ChannelHandler 是否对该 inbound 事件感兴趣，从而决定是否执行用户自定义 ChannelHandler 中的相应回调方法或者跳过对该 inbound 事件不感兴趣的 ChannelHandler 继续向后传播。

从以上描述中，我们也可以窥探出，Netty 引入 ChannelHandlerContext 来封装 ChannelHandler 的原因，在代码设计上还是遵循单一职责的原则， ChannelHandler 是用户接触最频繁的一个 netty 组件，netty 希望用户能够把全部注意力放在最核心的 IO 处理上，用户只需要关心自己对哪些异步事件感兴趣并考虑相应的处理逻辑即可，而并不需要关心异步事件在 pipeline 中如何传递，如何选择具有执行条件的 ChannelHandler 去执行或者跳过。这些切面性质的逻辑，netty 将它们作为上下文信息全部封装在 ChannelHandlerContext 中由netty框架本身负责处理。

以上这些内容，笔者还会在事件传播相关小节做详细的介绍，之所以这里引出，还是为了让大家感受下利用掩码进行集合操作的便利性，netty 中类似这样的设计还有很多，比如前边系列文章中多次提到过的，channel 再向 reactor 注册 IO 事件时，netty 也是将 channel 感兴趣的 IO 事件用掩码的形式存储于 SelectionKey 中的 int interestOps 中。

接下来笔者就为大家介绍下这些 inbound 事件，并梳理出这些 inbound 事件的触发时机。方便大家根据各自业务需求灵活地进行监听。

### ExceptionCaught 事件

在本小节介绍的这些 inbound 类事件在 pipeline 中传播的过程中，如果在相应事件回调函数执行的过程中发生异常，那么就会触发对应 ChannelHandler 中的 exceptionCaught 事件回调。

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

当然用户可以选择在 exceptionCaught 事件回调中是否执行 ctx.fireExceptionCaught(cause) 从而决定是否将 exceptionCaught 事件继续向后传播。

```java
@Override
public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
    ..........
    ctx.fireExceptionCaught(cause);
}
```

当 netty 内核处理连接的接收，以及数据的读取过程中如果发生异常，会在整个 pipeline 中触发 exceptionCaught 事件的传播。

**这里笔者为什么要单独强调在 inbound 事件传播的过程中发生异常，才会回调 exceptionCaught 呢** ?

因为 inbound 事件一般都是由 netty 内核触发传播的，而 outbound 事件一般都是由用户选择触发的，比如用户在处理完业务逻辑触发的 write 事件或者 flush 事件。

而在用户触发 outbound 事件后，一般都会得到一个 ChannelPromise 。用户可以向 ChannelPromise 添加各种 listener 。当 outbound 事件在传播的过程中发生异常时，netty 会通知用户持有的这个 ChannelPromise ，**但不会触发 exceptionCaught 的回调**。

比如我们在[《一文搞懂Netty发送数据全流程》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484532&idx=1&sn=c3a8b37a2eb09509d9914494ef108c68&chksm=ce77c233f9004b25a29f9fdfb179e41646092d09bc89df2147a9fab66df13231e46dd6a5c26d&scene=21#wechat_redirect)一文中介绍到的在 write 事件传播的过程中就不会触发 exceptionCaught 事件回调。只是去通知用户的 ChannelPromise 。

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

**而 outbound 事件中只有 flush 事件的传播是个例外**，当 flush 事件在 pipeline 传播的过程中发生异常时，会触发对应异常 ChannelHandler 的 exceptionCaught 事件回调。因为 flush 方法的签名中不会给用户返回 ChannelPromise 。

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

当 main reactor 在启动的时候，NioServerSocketChannel 会被创建并初始化，随后就会向main reactor注册，当注册成功后就会在 NioServerSocketChannel 中的 pipeline 中传播 ChannelRegistered 事件。

当 main reactor 接收客户端发起的连接后，NioSocketChannel 会被创建并初始化，随后会向 sub reactor 注册，当注册成功后会在 NioSocketChannel 中的 pipeline 传播 ChannelRegistered 事件。

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729742836358-83f32b0d-7185-4e3b-9d92-e9357b8a1e66.png)

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

注意：此时对应的 channel 还没有注册 IO 事件到相应的 reactor 中。

### ChannelActive 事件

当 NioServerSocketChannel 再向 main reactor 注册成功并触发 ChannelRegistered 事件传播之后，随后就会在 pipeline 中触发 bind 事件，而 bind 事件是一个 outbound 事件，会从 pipeline 中的尾结点 TailContext 一直向前传播最终在 HeadContext 中执行真正的绑定操作。

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

当 netty 服务端 NioServerSocketChannel 绑定端口成功之后，才算是真正的 Active ，随后触发 ChannelActive 事件在 pipeline 中的传播。

之前我们也提到过判断 NioServerSocketChannel 是否 Active 的标准就是 : **底层 JDK Nio ServerSocketChannel 是否 open 并且 ServerSocket 是否已经完成绑定。**

```java
@Override
    public boolean isActive() {
        return isOpen() && javaChannel().socket().isBound();
    }
```

而客户端 NioSocketChannel 中触发 ChannelActive 事件就会比较简单，当 NioSocketChannel 再向 sub reactor 注册成功并触发 ChannelRegistered 之后，紧接着就会触发 ChannelActive 事件在 pipeline 中传播。

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

而客户端 NioSocketChannel 是否 Active 的标识是：底层 JDK NIO SocketChannel 是否 open 并且底层 socket 是否连接。毫无疑问，这里的 socket 一定是 connected 。所以直接触发 ChannelActive 事件。

```java
@Override
public boolean isActive() {
    SocketChannel ch = javaChannel();
    return ch.isOpen() && ch.isConnected();
}
```

注意：此时 channel 才会到相应的 reactor 中去注册感兴趣的 IO 事件。当用户自定义的 ChannelHandler 接收到 ChannelActive 事件时，表明 IO 事件已经注册到 reactor 中了。

### ChannelRead 和 ChannelReadComplete 事件

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729743027781-c39d995f-c302-487b-8d87-df4a325eb7f5.png)

当客户端有新连接请求的时候，服务端的 NioServerSocketChannel 上的 OP_ACCEPT 事件会活跃，随后 main reactor 会在一个 read loop 中不断的调用 serverSocketChannel.accept() 接收新的连接直到全部接收完毕或者达到 read loop 最大次数 16 次。

在 NioServerSocketChannel 中，每 accept 一个新的连接，就会在 pipeline 中触发 ChannelRead 事件。一个完整的 read loop 结束之后，会触发 ChannelReadComplete 事件。

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

当客户端 NioSocketChannel 上有请求数据到来时，NioSocketChannel 上的 OP_READ 事件活跃，随后 sub reactor 也会在一个 read loop 中对 NioSocketChannel 中的请求数据进行读取直到读取完毕或者达到 read loop 的最大次数 16 次。

在 read loop 的读取过程中，每读取一次就会在 pipeline 中触发 ChannelRead 事件。当一个完整的 read loop 结束之后，会在 pipeline 中触发 ChannelReadComplete 事件。

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729744423312-f27a354d-ff9b-42e5-898b-d7aaad2cfb84.png)

**这里需要注意的是当 ChannelReadComplete 事件触发时，此时并不代表 NioSocketChannel 中的请求数据已经读取完毕**，可能的情况是发送的请求数据太多，在一个 read loop 中读取不完达到了最大限制次数 16 次，还没全部读取完毕就退出了 read loop 。一旦退出 read loop 就会触发 ChannelReadComplete 事件。详细内容可以查看笔者的这篇文章[《Netty如何高效接收网络数据》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484244&idx=1&sn=831060fc38caa201d69f87305de7f86a&chksm=ce77c513f9004c05b48f849ff99997d6d7252453135ae856a029137b88aa70b8e046013d596e&scene=21#wechat_redirect)。

### ChannelWritabilityChanged 事件

当我们处理完业务逻辑得到业务处理结果后，会调用 ctx.write(msg) 触发 write 事件在 pipeline 中的传播。

```java
@Override
public void channelRead(final ChannelHandlerContext ctx, final Object msg) {
     ctx.write(msg);
}
```

最终 netty 会将发送数据 msg 写入 NioSocketChannel 中的待发送缓冲队列 ChannelOutboundBuffer 中。并等待用户调用 flush 操作从 ChannelOutboundBuffer 中将待发送数据 msg ，写入到底层 Socket 的发送缓冲区中。

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729744647535-6a9f4f8b-1ebb-482c-afb3-97d0fb346a59.png)

当对端的接收处理速度非常慢或者网络状况极度拥塞时，使得 TCP 滑动窗口不断的缩小，这就导致发送端的发送速度也变得越来越小，而此时用户还在不断的调用 ctx.write(msg) ，这就会导致 ChannelOutboundBuffer 会急剧增大，从而可能导致 OOM 。netty 引入了高低水位线来控制 ChannelOutboundBuffer 的内存占用。

```java
public final class WriteBufferWaterMark {

    private static final int DEFAULT_LOW_WATER_MARK = 32 * 1024;
    private static final int DEFAULT_HIGH_WATER_MARK = 64 * 1024;
}
```

当 ChanneOutboundBuffer 中的内存占用量超过高水位线时，netty 就会将对应的 channel 置为不可写状态，并在 pipeline 中触发 ChannelWritabilityChanged 事件。

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

当 ChannelOutboundBuffer 中的内存占用量低于低水位线时，netty 又会将对应的 NioSocketChannel 设置为可写状态，并再次触发 ChannelWritabilityChanged 事件。

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

用户可在自定义 ChannelHandler 中通过 ctx.channel().isWritable() 判断当前 channel 是否可写。

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

netty 提供了一种事件扩展机制可以允许用户自定义异步事件，这样可以使得用户能够灵活的定义各种复杂场景的处理机制。

下面我们来看下如何在 Netty 中自定义异步事件。

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

后续随着我们源码解读的深入，我们还会看到 Netty 自己本身也定义了许多 UserEvent 事件，我们后面还会在介绍，大家这里只是稍微了解一下相关的用法即可。

### ChannelInactive和ChannelUnregistered事件

当 Channel 被关闭之后会在 pipeline 中先触发 ChannelInactive 事件的传播然后在触发 ChannelUnregistered 事件的传播。

我们可以在 Inbound 类型的 ChannelHandler 中响应 ChannelInactive 和 ChannelUnregistered 事件。

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

这里和连接建立之后的事件触发顺序正好相反，连接建立之后是先触发 ChannelRegistered 事件然后在触发 ChannelActive 事件。

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

和 Inbound 类事件一样，Outbound 类事件也有对应的掩码表示。下面我们来看下 Outbound类事件的触发时机：

### read 事件

**大家这里需要注意区分 read 事件和 ChannelRead 事件的不同**。

ChannelRead 事件前边我们已经介绍了，当 NioServerSocketChannel 接收到新连接时，会触发 ChannelRead 事件在其 pipeline 上传播。

当 NioSocketChannel 上有请求数据时，在 read loop 中读取请求数据时会触发 ChannelRead 事件在其 pipeline 上传播。

而 read 事件则和 ChannelRead 事件完全不同，read 事件特指使 Channel 具备感知 IO 事件的能力。NioServerSocketChannel 对应的 OP_ACCEPT 事件的感知能力，NioSocketChannel 对应的是 OP_READ 事件的感知能力。

read 事件的触发是在当 channel 需要向其对应的 reactor 注册读类型事件时（比如 OP_ACCEPT 事件 和  OP_READ 事件）才会触发。read 事件的响应就是将 channel 感兴趣的 IO 事件注册到对应的 reactor 上。

比如 NioServerSocketChannel 感兴趣的是 OP_ACCEPT 事件， NioSocketChannel 感兴趣的是 OP_READ 事件。

在前边介绍 ChannelActive 事件时我们提到，当 channel 处于 active 状态后会在 pipeline 中传播 ChannelActive 事件。而在 HeadContext 中的 ChannelActive 事件回调中会触发 Read 事件的传播。

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

而在 HeadContext 中的 read 事件回调中会调用 Channel 的底层操作类 unsafe 的 beginRead 方法，在该方法中会向 reactor 注册 channel 感兴趣的 IO 事件。对于 NioServerSocketChannel 来说这里注册的就是 OP_ACCEPT 事件，对于 NioSocketChannel 来说这里注册的则是 OP_READ 事件。

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

**细心的同学可能注意到了 channel 对应的配置类中包含了一个 autoRead 属性，那么这个 autoRead 到底是干什么的呢？**

其实这是 netty 为大家提供的一种背压机制，用来防止 OOM ，想象一下当对端发送数据非常多并且发送速度非常快，而服务端处理速度非常慢，一时间消费不过来。而对端又在不停的大量发送数据，服务端的 reactor 线程不得不在 read loop 中不停的读取，并且为读取到的数据分配 ByteBuffer 。而服务端业务线程又处理不过来，这就导致了大量来不及处理的数据占用了大量的内存空间，从而导致 OOM 。

面对这种情况，我们可以通过 `channelHandlerContext.channel().config().setAutoRead(false)` 将 autoRead 属性设置为 false 。随后 netty 就会将 channel 中感兴趣的读类型事件从 reactor 中注销，从此 reactor 不会再对相应事件进行监听。这样 channel 就不会在读取数据了。

这里 NioServerSocketChannel 对应的是 OP_ACCEPT 事件， NioSocketChannel 对应的是 OP_READ 事件。

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

而当服务端的处理速度恢复正常，我们又可以通过 `channelHandlerContext.channel().config().setAutoRead(true)` 将 autoRead 属性设置为 true 。这样 netty 会在 pipeline 中触发 read 事件，最终在 HeadContext 中的 read 事件回调方法中通过调用 unsafe#beginRead 方法将 channel 感兴趣的读类型事件重新注册到对应的 reactor 中。

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

read 事件可以理解为使 channel 拥有读的能力，当有了读的能力后， channelRead 就可以读取具体的数据了。

### write 和 flush 事件

write 事件和 flush 事件我们在[《一文搞懂Netty发送数据全流程》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484532&idx=1&sn=c3a8b37a2eb09509d9914494ef108c68&chksm=ce77c233f9004b25a29f9fdfb179e41646092d09bc89df2147a9fab66df13231e46dd6a5c26d&scene=21#wechat_redirect)一文中已经非常详尽的介绍过了，这里笔者在带大家简单回顾一下。

write 事件和 flush 事件均由用户在处理完业务请求得到业务结果后在业务线程中主动触发。

用户既可以通过 ChannelHandlerContext 触发也可以通过 Channel 来触发。

不同之处在于如果通过 ChannelHandlerContext 触发，那么 write 事件或者 flush 事件就会在 pipeline 中从当前 ChannelHandler 开始一直向前传播直到 HeadContext 。

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

如果通过 Channel 触发，那么 write 事件和 flush 事件就会从 pipeline 的尾部节点 TailContext 开始一直向前传播直到 HeadContext 。

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

当然还有一个 writeAndFlush 方法，也会分为 ChannelHandlerContext 触发和 Channel 的触发。触发 writeAndFlush 后，write 事件首先会在 pipeline 中传播，最后 flush 事件在 pipeline 中传播。

netty 对 write 事件的处理最终会将发送数据写入 Channel 对应的写缓冲队列 ChannelOutboundBuffer 中。此时数据并没有发送出去而是在写缓冲队列中缓存，这也是 netty 实现异步写的核心设计。

最终通过 flush 操作从 Channel 中的写缓冲队列 ChannelOutboundBuffer 中获取到待发送数据，并写入到 Socket 的发送缓冲区中。

### close 事件

当用户在 ChannelHandler 中调用如下方法对 Channel 进行关闭时，会触发 Close 事件在 pipeline 中从后向前传播。

```java
//close事件从当前ChannelHandlerContext开始在pipeline中向前传播
ctx.close();
//close事件从pipeline的尾结点tailContext开始向前传播
ctx.channel().close();
```

我们可以在Outbound类型的ChannelHandler中响应close事件。

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

最终 close 事件会在 pipeline 中一直向前传播直到头结点 HeadConnect 中，并在 HeadContext 中完成连接关闭的操作，当连接完成关闭之后，会在 pipeline中先后触发 ChannelInactive 事件和 ChannelUnregistered 事件。

### deRegister 事件

用户可调用如下代码将当前 Channel 从 Reactor 中注销掉。

```java
//deregister事件从当前ChannelHandlerContext开始在pipeline中向前传播
ctx.deregister();
//deregister事件从pipeline的尾结点tailContext开始向前传播
ctx.channel().deregister();
```

我们可以在 Outbound 类型的 ChannelHandler 中响应 deregister 事件。

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

最终 deRegister 事件会传播至 pipeline 中的头结点 HeadContext 中，并在 HeadContext 中完成底层 channel 取消注册的操作。当 Channel 从 Reactor 上注销之后，从此 Reactor 将不会在监听 Channel 上的 IO 事件，并触发 ChannelUnregistered 事件在 pipeline 中传播。

### connect 事件

在 Netty 的客户端中我们可以利用 NioSocketChannel 的 connect 方法触发 connect 事件在 pipeline 中传播。

```java
//connect事件从当前ChannelHandlerContext开始在pipeline中向前传播
ctx.connect(remoteAddress);
//connect事件从pipeline的尾结点tailContext开始向前传播
ctx.channel().connect(remoteAddress);
```

我们可以在 Outbound 类型的 ChannelHandler 中响应 connect 事件。

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

最终 connect 事件会在 pipeline 中的头结点 headContext 中触发底层的连接建立请求。当客户端成功连接到服务端之后，会在客户端 NioSocketChannel 的 pipeline 中传播 channelActive 事件。

### disConnect 事件

在 Netty 的客户端中我们也可以调用 NioSocketChannel 的 disconnect 方法在 pipeline 中触发 disconnect 事件，这会导致 NioSocketChannel 的关闭。

```java
//disconnect事件从当前ChannelHandlerContext开始在pipeline中向前传播
ctx.disconnect();
//disconnect事件从pipeline的尾结点tailContext开始向前传播
ctx.channel().disconnect();
```

我们可以在 Outbound 类型的 ChannelHandler 中响应 disconnect 事件。

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

最终 disconnect 事件会传播到 HeadContext 中，并在 HeadContext 中完成底层的断开连接操作，当客户端断开连接成功关闭之后，会在 pipeline 中先后触发 ChannelInactive 事件和 ChannelUnregistered 事件。

## 事件传播

在本文第三小节《3. pipeline中的事件分类》中我们介绍了 Netty 事件类型共分为三大类，分别是 Inbound类事件，Outbound类事件，ExceptionCaught事件。并详细介绍了这三类事件的掩码表示，和触发时机，以及事件传播的方向。

本小节我们就来按照 Netty 中异步事件的分类从源码角度分析下事件是如何在 pipeline 中进行传播的。

### Inbound 事件的传播

在第三小节中我们介绍了所有的 Inbound 类事件，这些事件在 pipeline 中的传播逻辑和传播方向都是一样的，唯一的区别就是执行的回调方法不同。

本小节我们就以 ChannelRead 事件的传播为例，来说明 Inbound 类事件是如何在 pipeline 中进行传播的。

第三小节中我们提到过，在 NioSocketChannel 中，ChannelRead 事件的触发时机是在每一次 read loop 读取数据之后在 pipeline 中触发的。

```java
do {
          ............               
    allocHandle.lastBytesRead(doReadBytes(byteBuf));

          ............

    // 在客户端NioSocketChannel的pipeline中触发ChannelRead事件
    pipeline.fireChannelRead(byteBuf);

} while (allocHandle.continueReading());
```

从这里可以看到，任何 Inbound 类事件在 pipeline 中的传播起点都是从 HeadContext 头结点开始的。

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

ChannelRead 事件从 HeadContext 开始在 pipeline 中传播，首先就会回调 HeadContext 中的 channelRead 方法。

在执行 ChannelHandler 中的相应事件回调方法时，需要确保回调方法的执行在指定的 executor 中进行。

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

在执行 HeadContext 的 channelRead 方法发生异常时，就会回调 HeadContext 的 exceptionCaught 方法。并在相应的事件回调方法中决定是否将事件继续在 pipeline 中传播。

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

在 HeadContext 中通过 ctx.fireChannelRead(msg) 继续将 ChannelRead 事件在 pipeline 中向后传播。

```java
abstract class AbstractChannelHandlerContext implements ChannelHandlerContext, ResourceLeakHint {

    @Override
    public ChannelHandlerContext fireChannelRead(final Object msg) {
        invokeChannelRead(findContextInbound(MASK_CHANNEL_READ), msg);
        return this;
    }

}
```

**这里的 findContextInbound 方法是整个 inbound 类事件在 pipeline 中传播的核心所在。**

因为我们现在需要继续将 ChannelRead 事件在 pipeline 中传播，所以我们目前的核心问题就是通过 findContextInbound 方法在 pipeline 中找到下一个对 ChannelRead 事件感兴趣的 ChannelInboundHandler 。然后执行该 ChannelInboundHandler 的 ChannelRead 事件回调。

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

ChannelRead 事件就这样循环往复的一直在 pipeline 中传播，在传播的过程中只有对 ChannelRead 事件感兴趣的 ChannelInboundHandler 才可以响应。其他类型的 ChannelHandler 则直接跳过。

如果 ChannelRead 事件在 pipeline 中传播的过程中，没有得到其他 ChannelInboundHandler 的有效处理，最终会被传播到 pipeline 的末尾 TailContext 中。而在本文第二小节中，我们也提到过 TailContext 对于 inbound 事件存在的意义就是做一个兜底的处理。比如：打印日志，释放 bytebuffer 。

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

本小节要介绍的 findContextInbound 方法和我们在上篇文章[《一文聊透 Netty 发送数据全流程》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484532&idx=1&sn=c3a8b37a2eb09509d9914494ef108c68&chksm=ce77c233f9004b25a29f9fdfb179e41646092d09bc89df2147a9fab66df13231e46dd6a5c26d&scene=21#wechat_redirect)中介绍的 findContextOutbound 方法均是 netty 异步事件在 pipeline 中传播的核心所在。

事件传播的核心问题就是需要高效的在 pipeline 中按照事件的传播方向，找到下一个具有响应事件资格的 ChannelHandler 。

比如：这里我们在 pipeline 中传播的 ChannelRead 事件，我们就需要在 pipeline 中找到下一个对 ChannelRead 事件感兴趣的 ChannelInboundHandler ，并执行该 ChannelInboudnHandler 的 ChannelRead 事件回调，在 ChannelRead 事件回调中对事件进行业务处理，并决定是否通过 ctx.fireChannelRead(msg) 将 ChannelRead 事件继续向后传播。

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

参数 mask 表示我们正在传播的 ChannelRead 事件掩码 MASK_CHANNEL_READ 。

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

通过 ctx = ctx.next 在 pipeline 中找到下一个 ChannelHandler ，并通过 skipContext 方法判断下一个 ChannelHandler 是否具有响应事件的资格。如果没有则跳过继续向后查找。

比如：下一个 ChannelHandler 如果是一个 ChannelOutboundHandler，或者下一个 ChannelInboundHandler 对 ChannelRead 事件不感兴趣，那么就直接跳过。

### skipContext

该方法主要用来判断下一个 ChannelHandler 是否具有 mask 代表的事件的响应资格。

```java
private static boolean skipContext(
        AbstractChannelHandlerContext ctx, EventExecutor currentExecutor, int mask, int onlyMask) {

    return (ctx.executionMask & (onlyMask | mask)) == 0 ||
            (ctx.executor() == currentExecutor && (ctx.executionMask & mask) == 0);
}
```

- 参数 onlyMask 表示我们需要查找的 ChannelHandler 类型，比如这里我们正在传播 ChannelRead 事件，它是一个 inbound 类事件，那么必须只能由 ChannelInboundHandler 来响应处理，所以这里传入的 onlyMask 为 MASK_ONLY_INBOUND （ ChannelInboundHandler 的掩码表示）
- ctx.executionMask 我们已经在《5.3 ChanneHandlerContext》小节中详细介绍过了，当 ChannelHandler 被添加进 pipeline 中时，需要计算出该 ChannelHandler 感兴趣的事件集合掩码来，保存在对应 ChannelHandlerContext 的 executionMask 字段中。
- 首先会通过 `ctx.executionMask & (onlyMask | mask)) == 0` 来判断下一个 ChannelHandler 类型是否正确，比如我们正在传播 inbound 类事件，下一个却是一个 ChannelOutboundHandler ，那么肯定是要跳过的，继续向后查找。
- 如果下一个 ChannelHandler 的类型正确，那么就会通过 `(ctx.executionMask & mask) == 0` 来判断该 ChannelHandler 是否对正在传播的 mask 事件感兴趣。如果该  ChannelHandler 中覆盖了 ChannelRead 回调则执行，如果没有覆盖对应的事件回调方法则跳过，继续向后查找，直到 TailContext 。

以上就是 skipContext 方法的核心逻辑，这里表达的核心语义是：

- 如果 pipeline 中传播的是 inbound 类事件，则必须由 ChannelInboundHandler 来响应，并且该 ChannelHandler 必须覆盖实现对应的 inbound 事件回调。
- 如果 pipeline 中传播的是 outbound 类事件，则必须由 ChannelOutboundHandler 来响应，并且该 ChannelHandler 必须覆盖实现对应的 outbound 事件回调。

这里大部分同学可能会对 `ctx.executor() == currentExecutor ` 这个条件感到很疑惑。加上这个条件，其实对我们这里的核心语义并没有多大影响。

- 当 ctx.executor() == currentExecutor 也就是说前后两个 ChannelHandler 指定的 executor 相同时，我们核心语义保持不变。
- 当 `ctx.executor() != currentExecutor ` 也就是前后两个 ChannelHandler 指定的 executor 不同时，**语义变为：只要前后两个 ChannelHandler 指定的 executor 不同，不管下一个ChannelHandler有没有覆盖实现指定事件的回调方法，均不能跳过。** 在这种情况下会执行到 ChannelHandler 的默认事件回调方法，继续在 pipeline 中传递事件。我们在《5.3 ChanneHandlerContext》小节提到过 ChannelInboundHandlerAdapter 和 ChannelOutboundHandlerAdapter 会分别对 inbound 类事件回调方法和 outbound 类事件回调方法进行默认的实现。

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

而这里之所以需要加入 `ctx.executor() == currentExecutor` 条件的判断，是为了防止 HttpContentCompressor 在被指定不同的 executor 情况下无法正确的创建压缩内容，导致的一些异常。但这个不是本文的重点，大家只需要理解这里的核心语义就好，这种特殊情况的特殊处理了解一下就好。

### Outbound事件的传播

关于 Outbound 类事件的传播，笔者在上篇文章[《一文搞懂 Netty 发送数据全流程》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484532&idx=1&sn=c3a8b37a2eb09509d9914494ef108c68&chksm=ce77c233f9004b25a29f9fdfb179e41646092d09bc89df2147a9fab66df13231e46dd6a5c26d&scene=21#wechat_redirect)中已经进行了详细的介绍，本小节就不在赘述。

### ExceptionCaught事件的传播

在最后我们来介绍下异常事件在 pipeline 中的传播，ExceptionCaught 事件和 Inbound 类事件一样都是在 pipeline 中从前往后开始传播。

ExceptionCaught 事件的触发有两种情况：一种是 netty 框架内部产生的异常，这时 netty 会直接在 pipeline 中触发 ExceptionCaught 事件的传播。异常事件会在 pipeline 中从 HeadContext 开始一直向后传播直到 TailContext。

比如 netty 在 read loop 中读取数据时发生异常：

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

这时会 netty 会直接从 pipeline 中触发 ExceptionCaught 事件的传播。

```java
private void handleReadException(ChannelPipeline pipeline, ByteBuf byteBuf, Throwable cause, boolean close,
    RecvByteBufAllocator.Handle allocHandle) {
 
        .............

    pipeline.fireExceptionCaught(cause);
    
        .............

}
```

和 Inbound 类事件一样，ExceptionCaught 事件会在 pipeline 中从 HeadContext 开始一直向后传播。

```java
@Override
public final ChannelPipeline fireExceptionCaught(Throwable cause) {
    AbstractChannelHandlerContext.invokeExceptionCaught(head, cause);
    return this;
}
```

第二种触发 ExceptionCaught 事件的情况是，当 Inbound 类事件或者 flush 事件在 pipeline 中传播的过程中，在某个 ChannelHandler 中的事件回调方法处理中发生异常，这时该 ChannelHandler 的 exceptionCaught 方法会被回调。用户可以在这里处理异常事件，并决定是否通过 ctx.fireExceptionCaught(cause) 继续向后传播异常事件。

比如我们在 ChannelInboundHandler 中的 ChannelRead 回调中处理业务请求时发生异常，就会触发该 ChannelInboundHandler 的 exceptionCaught 方法。



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

再比如：当我们在 ChannelOutboundHandler 中的 flush 回调中处理业务结果发送的时候发生异常，也会触发该 ChannelOutboundHandler 的 exceptionCaught 方法。

```java
private void invokeFlush0() {
    try {
        ((ChannelOutboundHandler) handler()).flush(this);
    } catch (Throwable t) {
        invokeExceptionCaught(t);
    }
}
```

我们可以在 ChannelHandler 的 exceptionCaught 回调中进行异常处理，并决定是否通过 ctx.fireExceptionCaught(cause) 继续向后传播异常事件。

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

虽然 ExceptionCaught 事件和 Inbound 类事件在传播方向都是在 pipeline 中从前向后传播。但是大家这里注意区分这两个事件的区别。

**在 Inbound 类事件传播过程中是会查找下一个具有事件响应资格的 ChannelInboundHandler 。遇到 ChannelOutboundHandler 会直接跳过。**

**而 ExceptionCaught 事件无论是在哪种类型的 channelHandler 中触发的，都会从当前异常 ChannelHandler 开始一直向后传播，ChannelInboundHandler 可以响应该异常事件，ChannelOutboundHandler 也可以响应该异常事件。**

由于无论异常是在 ChannelInboundHandler 中产生的还是在 ChannelOutboundHandler 中产生的， exceptionCaught 事件都会在 pipeline 中是从前向后传播，并且不关心 ChannelHandler 的类型。**所以我们一般将负责统一异常处理的 ChannelHandler 放在 pipeline 的最后**，这样它对于 inbound 类异常和 outbound 类异常均可以捕获得到。

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729751926201-bf6d019a-b5d2-4dcb-be61-dfca7c19235c.png)

## 