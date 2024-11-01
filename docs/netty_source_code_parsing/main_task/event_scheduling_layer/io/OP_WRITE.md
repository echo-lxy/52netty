# 处理 OP_WRITE 事件

## 前言

在[《处理 OP_READ 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_READ)一文中，我们介绍了 **Netty** 的 **Sub Reactor** 处理网络数据读取的完整过程。当 **Netty** 为我们读取了网络请求数据，并且我们在自己的业务线程中完成了业务处理后，通常需要将业务处理结果返回给客户端。本文将介绍 **Sub Reactor** 如何处理网络数据发送的整个过程。

我们都知道 **Netty** 是一款高性能的异步事件驱动的网络通讯框架，既然是网络通讯框架，那么它主要做的事情就是：

- 接收客户端连接
- 读取连接上的网络请求数据
- 向连接发送网络响应数据

在之前的系列文章中，我们在介绍 **Netty** 的启动以及接收连接的过程中，看到的是 **OP_ACCEPT** 事件和 **OP_READ** 事件的注册，却没有看到 **OP_WRITE** 事件的注册。

- **那么在什么情况下，Netty 才会向 SubReactor 去注册 OP_WRITE 事件呢？**
- **Netty 又是如何对写操作做到异步处理的呢？**

本文笔者将为大家一一揭晓这些谜底。我们仍然以之前的 **EchoServer** 为例进行说明。

```java
@Sharable
public class EchoServerHandler extends ChannelInboundHandlerAdapter {

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        //此处的msg就是Netty在read loop中从NioSocketChannel中读取到的ByteBuffer
        ctx.write(msg);
    }

}
```

我们在[《处理 OP_READ 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_READ)一文中读取到的 `ByteBuffer`（这里的 `Object msg`），直接发送回给客户端，用这个简单的例子来揭开 Netty 如何发送数据的序幕。

在实际开发中，我们首先要通过解码器将读取到的 `ByteBuffer` 解码转换为我们的业务 `Request` 类，然后在业务线程中进行业务处理。接着，通过编码器将业务 `Response` 类编码为 `ByteBuffer`，最后利用 `ChannelHandlerContext ctx` 的引用发送响应数据。

本文将专注于 Netty 写数据的过程，对于 Netty 编解码相关的内容，笔者会在后续的文章中专门介绍。

## write 方法发送数据

### 传播 write 事件

无论是在业务线程还是在 Sub Reactor 线程中完成业务处理后，我们都需要通过 `ChannelHandlerContext` 的引用，将 `write` 事件在 `pipeline` 中进行传播。然后，在 `pipeline` 中相应的 `ChannelHandler` 中监听 `write` 事件，以便对其进行自定义处理（比如常用的编码器），最终将事件传播到 `HeadContext` 中以执行发送数据的逻辑操作。

前面提到 `Netty` 中有两个触发 `write` 事件传播的方法，它们的处理逻辑是相同的，只是它们在 `pipeline` 中的传播起点不同：

- `channelHandlerContext.write()` 方法会从当前 `ChannelHandler` 开始在 `pipeline` 中向前传播 `write` 事件，直到 `HeadContext`。
- `channelHandlerContext.channel().write()` 方法则会从 `pipeline` 的尾结点 `TailContext` 开始向前传播 `write` 事件，直到 `HeadContext`。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311732837.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031173204745" style="zoom:50%;" />

在我们了解了 `write` 事件的总体传播流程后，接下来看看在 `write` 事件传播过程中，Netty 为我们做了哪些处理。这里以 `channelHandlerContext.write()` 方法为例进行说明。

```java
abstract class AbstractChannelHandlerContext implements ChannelHandlerContext, ResourceLeakHint {

    @Override
    public ChannelFuture write(Object msg) {
        return write(msg, newPromise());
    }

    @Override
    public ChannelFuture write(final Object msg, final ChannelPromise promise) {
        write(msg, false, promise);
        return promise;
    }

}
```

在这里我们看到，Netty 的写操作是**异步**的。当我们在业务线程中调用 `channelHandlerContext.write()` 后，Netty 会返回一个 `ChannelFuture`，我们可以在这个 `ChannelFuture` 中添加 `ChannelFutureListener`。这样，当 Netty 将我们要发送的数据写入到底层 Socket 时，它会通过 `ChannelFutureListener` 通知我们写入结果。

以下是业务线中的代码

```java
@Override
public void channelRead(final ChannelHandlerContext ctx, final Object msg) {
    //此处的msg就是Netty在read loop中从NioSocketChannel中读取到的ByteBuffer
    ChannelFuture future = ctx.write(msg);
    future.addListener(new ChannelFutureListener() {
        @Override
        public void operationComplete(ChannelFuture future) throws Exception {
            Throwable cause = future.cause();
            if (cause != null) {
                 处理异常情况
            } else {
                 写入Socket成功后，Netty会通知到这里
            }
        }
    });
}
```

当异步事件在 `pipeline` 中传播时发生异常，异步事件的传播将会停止。因此，在日常开发中，我们需要对写操作中的异常情况进行处理：

- 对于 **inbound** 类异步事件发生异常时，**会触发 `exceptionCaught` 事件传播**。`exceptionCaught` 事件本身也是一种 inbound 事件，传播方向从发生异常的 `ChannelHandler` 开始，一直向后传播直到 `TailContext`。
- 而对于 **outbound** 类异步事件发生异常时，**不会触发 `exceptionCaught` 事件传播**，通常只是通知相关的 `ChannelFuture`。但如果是 `flush` 事件在传播过程中发生异常，则会触发当前发生异常的 `ChannelHandler` 中的 `exceptionCaught` 事件回调。

接下来，我们继续回归到写操作的主线来分析。

```java
private void write(Object msg, boolean flush, ChannelPromise promise) {
    ObjectUtil.checkNotNull(msg, "msg");

    ................省略检查promise的有效性...............

    //flush = true 表示channelHandler中调用的是writeAndFlush方法，这里需要找到pipeline中覆盖write或者flush方法的channelHandler
    //flush = false 表示调用的是write方法，只需要找到pipeline中覆盖write方法的channelHandler
    final AbstractChannelHandlerContext next = findContextOutbound(flush ?
            (MASK_WRITE | MASK_FLUSH) : MASK_WRITE);
    //用于检查内存泄露
    final Object m = pipeline.touch(msg, next);
    //获取pipeline中下一个要被执行的channelHandler的executor
    EventExecutor executor = next.executor();
    //确保OutBound事件由ChannelHandler指定的executor执行
    if (executor.inEventLoop()) {
        //如果当前线程正是channelHandler指定的executor则直接执行
        if (flush) {
            next.invokeWriteAndFlush(m, promise);
        } else {
            next.invokeWrite(m, promise);
        }
    } else {
        //如果当前线程不是ChannelHandler指定的executor,则封装成异步任务提交给指定executor执行，注意这里的executor不一定是reactor线程。
        final WriteTask task = WriteTask.newInstance(next, m, promise, flush);
        if (!safeExecute(executor, task, promise, m, !flush)) {
            task.cancel();
        }
    }
}
```

`write` 事件在 `pipeline` 中向前传播时，需要找到下一个有执行资格的 `ChannelHandler`。因为当前 `ChannelHandler` 前面的处理器可能是 `ChannelInboundHandler` 类型，也可能是 `ChannelOutboundHandler` 类型，或者可能根本不关心 `write` 事件的处理（即没有实现 `write` 回调方法）。

![image-20241031174147729](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311741849.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

在这里，我们需要使用 `findContextOutbound` 方法，在当前 `ChannelHandler` 前的链路中查找一个类型为 `ChannelOutboundHandler` 的处理器，并确保其覆盖实现了 `write` 回调方法。找到后，该 `ChannelHandler` 将作为下一个执行目标。

通过 `findContextOutbound` 方法，我们在 `pipeline` 中找到了下一个具有执行资格的 `ChannelHandler`，即下一个类型为 `ChannelOutboundHandler` 且覆盖实现了 `write` 方法的 `ChannelHandler`。接下来，Netty 会调用这个 `nextChannelHandler` 的 `write` 方法，以实现 `write` 事件在 `pipeline` 中的传播。

```java
private void write(Object msg, boolean flush, ChannelPromise promise) {
    ObjectUtil.checkNotNull(msg, "msg");

    ................省略检查promise的有效性...............

    //flush = true 表示channelHandler中调用的是writeAndFlush方法，这里需要找到pipeline中覆盖write或者flush方法的channelHandler
    //flush = false 表示调用的是write方法，只需要找到pipeline中覆盖write方法的channelHandler
    final AbstractChannelHandlerContext next = findContextOutbound(flush ?
            (MASK_WRITE | MASK_FLUSH) : MASK_WRITE);
    //用于检查内存泄露
    final Object m = pipeline.touch(msg, next);
    //获取pipeline中下一个要被执行的channelHandler的executor
    EventExecutor executor = next.executor();
    //确保OutBound事件由ChannelHandler指定的executor执行
    if (executor.inEventLoop()) {
        //如果当前线程正是channelHandler指定的executor则直接执行
        if (flush) {
            next.invokeWriteAndFlush(m, promise);
        } else {
            next.invokeWrite(m, promise);
        }
    } else {
        //如果当前线程不是ChannelHandler指定的executor,则封装成异步任务提交给指定executor执行，注意这里的executor不一定是reactor线程。
        final WriteTask task = WriteTask.newInstance(next, m, promise, flush);
        if (!safeExecute(executor, task, promise, m, !flush)) {
            task.cancel();
        }
    }
}
```

在向 `pipeline` 添加 `ChannelHandler` 时，可以通过 `ChannelPipeline#addLast(EventExecutorGroup, ChannelHandler...)` 方法指定执行该 `ChannelHandler` 的 `executor`。如果未特别指定，执行该 `ChannelHandler` 的 `executor` 默认为与该 `Channel` 绑定的 Reactor 线程。

执行 `ChannelHandler` 中异步事件回调方法的线程必须是 `ChannelHandler` 指定的 `executor`。

因此，首先我们需要获取在 `findContextOutbound` 方法查找出来的下一个符合执行条件的 `ChannelHandler` 指定的 `executor`。

```java
EventExecutor executor = next.executor()
```

并通过 `executor.inEventLoop()` 方法判断当前线程是否是该 `ChannelHandler` 指定的 `executor`。如果是，则直接在当前线程中执行 `ChannelHandler` 中的 `write` 方法。如果不是，则需要将 `ChannelHandler` 对 `write` 事件的回调操作封装成异步任务 `WriteTask`，并将其提交给指定的 `executor`，由该 `executor` 负责执行。

需要注意的是，这个 `executor` 并不一定是与 `channel` 绑定的 Reactor 线程。它可以是我们自定义的线程池，但必须通过 `ChannelPipeline#addLast` 方法进行指定。如果不进行指定，默认情况下，执行 `ChannelHandler` 的 `executor` 才是与 `channel` 绑定的 Reactor 线程。

在此，Netty 需要确保 `outbound` 事件是由 `ChannelHandler` 指定的 `executor` 执行的。

**这里有些同学可能会有疑问，如果我们向 pipieline 添加 ChannelHandler 的时候，为每个 ChannelHandler 指定不同的 executor 时，Netty 如果确保线程安全呢**？？

大家还记得 pipeline 中的结构吗？

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311742560.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031174210480" style="zoom:50%;" />

`outbound` 事件在 `pipeline` 中的传播最终会到达 `HeadContext`。在之前的系列文章中，我们提到过，`HeadContext` 封装了 `Channel` 的 `Unsafe` 类，负责 `Channel` 底层的 IO 操作。值得注意的是，`HeadContext` 指定的 `executor` 正是与 `channel` 绑定的 Reactor 线程。

![image-20241101141309452](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411011413564.png)

以最终在 Netty 内核中执行写操作的线程一定是 Reactor 线程，从而保证了线程安全性。

忘记这段内容的同学可以回顾一下 [《BootStrap 初始化》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_init)。类似的套路我们在介绍 `NioServerSocketChannel` 进行 `bind` 绑定以及 `register` 注册时也提到过，只不过这里将 `executor` 扩展到了自定义线程池的范围。

![image-20241031174347213](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311743334.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

```java
//如果当前线程是指定的 executor 则直接操作
if (flush) {
    next.invokeWriteAndFlush(m, promise);
} else {
    next.invokeWrite(m, promise);
}
```

由于我们在示例 `ChannelHandler` 中调用的是 `ChannelHandlerContext#write` 方法，所以这里的 `flush` 为 `false`。这将触发调用下一个 `ChannelHandler` 的 `write` 方法。

```java
void invokeWrite(Object msg, ChannelPromise promise) {
    if (invokeHandler()) {
        invokeWrite0(msg, promise);
    } else {
        // 当前channelHandler虽然添加到pipeline中，但是并没有调用handlerAdded
        // 所以不能调用当前channelHandler中的回调方法，只能继续向前传递write事件
        write(msg, promise);
    }
}
```

首先，需要通过 `invokeHandler()` 方法判断 `nextChannelHandler` 中的 `handlerAdded` 方法是否已经被回调。只有当 `ChannelHandler` 被正确添加到对应的 `ChannelHandlerContext` 中，并且准备好处理异步事件时，`ChannelHandler#handlerAdded` 方法才会被回调。

这一部分内容笔者会在下一篇文章中详细为大家介绍，这里大家只需要了解调用 `invokeHandler()` 方法的目的就是为了确定 `ChannelHandler` 是否被正确初始化。

```java
private boolean invokeHandler() {
    // Store in local variable to reduce volatile reads.
    int handlerState = this.handlerState;
    return handlerState == ADD_COMPLETE || (!ordered && handlerState == ADD_PENDING);
}
```

只有在触发 `handlerAdded` 回调后，`ChannelHandler` 的状态才能变为 `ADD_COMPLETE`。如果 `invokeHandler()` 方法返回 `false`，则需要跳过这个 `nextChannelHandler`，并调用 `ChannelHandlerContext#write` 方法继续向前传播 `write` 事件。

```java
@Override
public ChannelFuture write(final Object msg, final ChannelPromise promise) {
    //继续向前传播write事件，回到流程起点
    write(msg, false, promise);
    return promise;
}
```

如果 `invokeHandler()` 返回 `true`，则说明 `nextChannelHandler` 已经在 `pipeline` 中正确初始化。此时，Netty 会直接调用该 `ChannelHandler` 的 `write` 方法，从而实现 `write` 事件从当前 `ChannelHandler` 传播到 `nextChannelHandler`。

```java
private void invokeWrite0(Object msg, ChannelPromise promise) {
    try {
        //调用当前ChannelHandler中的write方法
        ((ChannelOutboundHandler) handler()).write(this, msg, promise);
    } catch (Throwable t) {
        notifyOutboundHandlerException(t, promise);
    }
}
```

在 `write` 事件的传播过程中，如果发生异常，则 `write` 事件会停止在 `pipeline` 中传播，并通知注册的 `ChannelFutureListener`。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311742560.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031174210480" style="zoom:50%;" />

从本文示例的 `pipeline` 结构中可以看出，当在 `EchoServerHandler` 中调用 `ChannelHandlerContext#write` 方法后，`write` 事件会在 `pipeline` 中向前传播至 `HeadContext`。在 `HeadContext` 中，Netty 才会真正处理 `write` 事件。

### HeadContext

```java
final class HeadContext extends AbstractChannelHandlerContext
        implements ChannelOutboundHandler, ChannelInboundHandler {

    @Override
    public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) {
        unsafe.write(msg, promise);
    }
}
```

`write` 事件最终会在 `pipeline` 中传播到 `HeadContext`，并回调 `HeadContext` 的 `write` 方法。在这个回调中，会调用 `channel` 的 `Unsafe` 类以执行底层的 `write` 操作。这正是 `write` 事件在 `pipeline` 中传播的终点。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311801283.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031180100928" style="zoom: 33%;" />

```java
protected abstract class AbstractUnsafe implements Unsafe {
    //待发送数据缓冲队列  Netty是全异步框架，所以这里需要一个缓冲队列来缓存用户需要发送的数据
    private volatile ChannelOutboundBuffer outboundBuffer = new ChannelOutboundBuffer(AbstractChannel.this);

    @Override
    public final void write(Object msg, ChannelPromise promise) {
        assertEventLoop();
        //获取当前channel对应的待发送数据缓冲队列（支持用户异步写入的核心关键）
        ChannelOutboundBuffer outboundBuffer = this.outboundBuffer;

        ..........省略..................

        int size;
        try {
            //过滤message类型 这里只会接受DirectBuffer或者fileRegion类型的msg
            msg = filterOutboundMessage(msg);
            //计算当前msg的大小
            size = pipeline.estimatorHandle().size(msg);
            if (size < 0) {
                size = 0;
            }
        } catch (Throwable t) {
          ..........省略..................
        }
        //将msg 加入到Netty中的待写入数据缓冲队列ChannelOutboundBuffer中
        outboundBuffer.addMessage(msg, size, promise);
    }

}
```

众所周知，Netty 是一个异步事件驱动的网络框架。在 Netty 中，所有的 IO 操作都是异步的，包括本小节介绍的 `write` 操作。为了确保 `write` 操作的异步执行，Netty 定义了一个待发送数据的缓冲队列 **`ChannelOutboundBuffer`**。在将用户需要发送的网络数据写入 Socket 之前，这些数据会先被缓存到 **`ChannelOutboundBuffer`** 中。

每个客户端 `NioSocketChannel` 对应一个 `ChannelOutboundBuffer` 待发送数据缓冲队列。

#### filterOutboundMessage

`ChannelOutboundBuffer` 仅接受 `ByteBuffer` 类型和 `FileRegion` 类型的消息数据。

FileRegion 是 Netty 定义的用来通过零拷贝的方式网络传输文件数据。本文我们主要聚焦普通网络数据 ByteBuffer 的发送。

因此，在将消息 (`msg`) 写入 `ChannelOutboundBuffer` 之前，我们需要检查待写入消息的类型，以确保它是 `ChannelOutboundBuffer` 可接受的类型。

```java
public abstract class AbstractNioByteChannel extends AbstractNioChannel{
    。。。
   	@Override
    protected final Object filterOutboundMessage(Object msg) {
        if (msg instanceof ByteBuf) {
            ByteBuf buf = (ByteBuf) msg;
            if (buf.isDirect()) {
                return msg;
            }

            return newDirectBuffer(buf);
        }

        if (msg instanceof FileRegion) {
            return msg;
        }

        throw new UnsupportedOperationException(
                "unsupported message type: " + StringUtil.simpleClassName(msg) + EXPECTED_TYPES);
    }
    。。。
}

```

在网络数据传输过程中，Netty 为了减少数据从堆内存到堆外内存的拷贝，并缓解 GC 的压力，采用了 `DirectByteBuffer`，使用堆外内存来存放网络发送的数据。

#### estimatorHandle 计算当前 msg 的大小

```java
public class DefaultChannelPipeline implements ChannelPipeline {
    //原子更新estimatorHandle字段
    private static final AtomicReferenceFieldUpdater<DefaultChannelPipeline, MessageSizeEstimator.Handle> ESTIMATOR =
            AtomicReferenceFieldUpdater.newUpdater(
                    DefaultChannelPipeline.class, MessageSizeEstimator.Handle.class, "estimatorHandle");

    //计算要发送msg大小的handler
    private volatile MessageSizeEstimator.Handle estimatorHandle;

    final MessageSizeEstimator.Handle estimatorHandle() {
        MessageSizeEstimator.Handle handle = estimatorHandle;
        if (handle == null) {
            handle = channel.config().getMessageSizeEstimator().newHandle();
            if (!ESTIMATOR.compareAndSet(this, null, handle)) {
                handle = estimatorHandle;
            }
        }
        return handle;
    }
}
```

在 `pipeline` 中，有一个 `estimatorHandle` 专门用于计算待发送 `ByteBuffer` 的大小。该 `estimatorHandle` 会在与 `pipeline` 对应的 `Channel` 配置类创建时被初始化。其实际类型为 `DefaultMessageSizeEstimator#HandleImpl`。

```java
public final class DefaultMessageSizeEstimator implements MessageSizeEstimator {

    private static final class HandleImpl implements Handle {
        private final int unknownSize;

        private HandleImpl(int unknownSize) {
            this.unknownSize = unknownSize;
        }

        @Override
        public int size(Object msg) {
            if (msg instanceof ByteBuf) {
                return ((ByteBuf) msg).readableBytes();
            }
            if (msg instanceof ByteBufHolder) {
                return ((ByteBufHolder) msg).content().readableBytes();
            }
            if (msg instanceof FileRegion) {
                return 0;
            }
            return unknownSize;
        }
    }
```

在这里，我们可以看到 `ByteBuffer` 的大小等于缓冲区中未读取的字节数，即 `writerIndex - readerIndex`。在验证了待写入数据 `msg` 的类型并计算了 `msg` 的大小后，我们就可以通过 `ChannelOutboundBuffer#addMessage` 方法将 `msg` 写入到 `ChannelOutboundBuffer`（待发送数据缓冲队列）中。

`write` 事件处理的最终逻辑是将待发送数据写入到 `ChannelOutboundBuffer` 中。接下来，我们将探讨 `ChannelOutboundBuffer` 的内部结构。

### ChannelOutboundBuffer

`ChannelOutboundBuffer` 实际上是一个单链表结构的缓冲队列，链表中的节点类型为 `Entry`。由于 `ChannelOutboundBuffer` 在 Netty 中的作用是缓存应用程序待发送的网络数据，因此 `Entry` 中封装的是待写入 Socket 的网络发送数据相关的信息，以及在 `ChannelHandlerContext#write` 方法中返回给用户的 `ChannelPromise`，以便在数据写入 Socket 后异步通知应用程序。

此外，`ChannelOutboundBuffer` 中还封装了三个重要的指针：

- **unflushedEntry**：指向 `ChannelOutboundBuffer` 中第一个待发送数据的 `Entry`。
- **tailEntry**：指向 `ChannelOutboundBuffer` 中最后一个待发送数据的 `Entry`。通过 `unflushedEntry` 和 `tailEntry`，我们可以方便地定位待发送数据的 `Entry` 范围。
- **flushedEntry**：在通过 `flush` 操作将 `ChannelOutboundBuffer` 中缓存的待发送数据发送到 Socket 时，`flushedEntry` 指针会指向 `unflushedEntry` 的位置。此时，`flushedEntry` 和 `tailEntry` 之间的 `Entry` 就是我们即将发送到 Socket 的网络数据。

这三个指针在初始化时均为 `null`。

![image-20241031181419963](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311814063.png)

#### Entry

`Entry` 作为 `ChannelOutboundBuffer` 链表结构中的节点元素，封装了待发送数据的各种信息。`ChannelOutboundBuffer` 实际上是对 `Entry` 结构的组织和操作。因此，理解 `Entry` 结构是理解整个 `ChannelOutboundBuffer` 运作流程的基础。

接下来，我们将探讨 `Entry` 结构具体封装了哪些待发送数据的信息。

```java
static final class Entry {
    //Entry的对象池，用来创建和回收Entry对象
    private static final ObjectPool<Entry> RECYCLER = ObjectPool.newPool(new ObjectCreator<Entry>() {
        @Override
        public Entry newObject(Handle<Entry> handle) {
            return new Entry(handle);
        }
    });

    //DefaultHandle用于回收对象
    private final Handle<Entry> handle;
    //ChannelOutboundBuffer下一个节点
    Entry next;
    //待发送数据
    Object msg;
    //msg 转换为 jdk nio 中的byteBuffer
    ByteBuffer[] bufs;
    ByteBuffer buf;
    //异步write操作的future
    ChannelPromise promise;
    //已发送了多少
    long progress;
    //总共需要发送多少，不包含entry对象大小。
    long total;
    //pendingSize表示entry对象在堆中需要的内存总量 待发送数据大小 + entry对象本身在堆中占用内存大小（96）
    int pendingSize;
    //msg中包含了几个jdk nio bytebuffer
    int count = -1;
    //write操作是否被取消
    boolean cancelled;
}
```

**我们看到 Entry 结构中一共有 12 个字段，其中 1 个静态字段和 11 个实例字段。**

下面笔者就为大家介绍下这 12 个字段的含义及其作用，其中有些字段会在后面的场景中使用到，这里大家可能对有些字段理解起来比较模糊，不过没关系，这里能看懂多少是多少，不理解也没关系，这里介绍只是为了让大家混个眼熟，在后面流程的讲解中，笔者还会重新提到这些字段。

- `ObjectPool<Entry> RECYCLER`：Entry 的对象池，负责创建管理 Entry 实例，由于 Netty 是一个网络框架，所以 IO 读写就成了它的核心操作，在一个支持高性能高吞吐的网络框架中，会有大量的 IO 读写操作，那么就会导致频繁的创建 Entry 对象。我们都知道，创建一个实例对象以及 GC 回收这些实例对象都是需要性能开销的，那么在大量频繁创建 Entry 对象的场景下，引入对象池来复用创建好的 Entry 对象实例可以抵消掉由频繁创建对象以及 GC 回收对象所带来的性能开销。
- `Handle<Entry> handle`：默认实现类型为 DefaultHandle ，用于数据发送完毕后，对象池回收 Entry 对象。由对象池 RECYCLER 在创建 Entry 对象的时候传递进来。
- `Entry next`：ChannelOutboundBuffer 是一个单链表的结构，这里的 next 指针用于指向当前 Entry 节点的后继节点。
- `Object msg`：应用程序待发送的网络数据，这里 msg 的类型为 DirectByteBuffer 或者 FileRegion（用于通过零拷贝的方式网络传输文件）。
- `ByteBuffer[] bufs`：这里的 ByteBuffer 类型为 JDK NIO 原生的 ByteBuffer 类型，因为 Netty 最终发送数据是通过 JDK NIO 底层的 SocketChannel 进行发送，所以需要将 Netty 中实现的 ByteBuffer 类型转换为 JDK NIO ByteBuffer 类型。应用程序发送的 ByteBuffer 可能是一个也可能是多个，如果发送多个就用 ByteBuffer[] bufs 封装在 Entry 对象中，如果是一个就用 ByteBuffer buf 封装。
- `int count`：表示待发送数据 msg 中一共包含了多少个 ByteBuffer 需要发送。
- `ChannelPromise promise`：ChannelHandlerContext#write 异步写操作返回的 ChannelFuture。当 Netty 将待发送数据写入到 Socket 中时会通过这个 ChannelPromise 通知应用程序发送结果。
- `long progress`：表示当前的一个发送进度，已经发送了多少数据。
- `long total`：Entry 中总共需要发送多少数据。注意：这个字段并不包含 Entry 对象的内存占用大小。只是表示待发送网络数据的大小。
- `boolean cancelled`：应用程序调用的 write 操作是否被取消。
- `int pendingSize`：表示待发送数据的内存占用总量。待发送数据在内存中的占用量分为两部分：
  - Entry 对象中所封装的待发送网络数据大小。
  - Entry 对象本身在内存中的占用量。

![image-20241031181427134](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311814323.png)

#### pendingSize 的作用

设想这样一个场景： 由于网络拥塞或 Netty 客户端负载过高，导致网络数据的接收和处理速度逐渐减慢。TCP 的滑动窗口不断缩小，最终可能降至 0。这时，Netty 服务端却仍然在频繁地执行写操作，不断地将数据写入 `ChannelOutboundBuffer` 中。

这种情况下，尽管数据无法发送出去，Netty 服务端却在不断写入数据，最终可能撑爆 `ChannelOutboundBuffer`，导致 **堆外内存的 OOM**（Out Of Memory）。因为 `ChannelOutboundBuffer` 中待发送的数据全部存储在堆外内存中。

为了避免这种情况的发生，Netty 必须限制 `ChannelOutboundBuffer` 中待发送数据的内存占用总量，防止其无限增长。为此，Netty 中定义了 **高低水位线**，用来表示 `ChannelOutboundBuffer` 中待发送数据的内存占用量的上限和下限。

- **高水位线**：当待发送数据的内存占用总量超过高水位线时，Netty 会将 `NioSocketChannel` 的状态标记为**不可写状态**，以防止 OOM 的发生。
- **低水位线**：当待发送数据的内存占用总量低于低水位线时，Netty 会将 `NioSocketChannel` 的状态标记为**可写状态**。

**那么，Netty 是如何记录** `ChannelOutboundBuffer` **中待发送数据的内存占用总量的呢？**

答案就是本小节要介绍的 pendingSize 字段。

很多人对待发送数据的内存占用量存在一个误解：他们通常只计算待发送数据的大小（即消息中包含的字节数），而忽略了 `Entry` 实例对象本身在内存中的占用量。因为 Netty 会将待发送数据封装在 `Entry` 实例对象中，而在频繁的写操作中会产生大量的 `Entry` 实例对象。

因此，`Entry` 实例对象的内存占用是不可忽视的。如果只计算待发送数据的大小，而不考虑 `Entry` 对象的内存占用，可能会导致在未达到高水位线时，因大量 `Entry` 实例对象存在而发生 OOM。

因此，`pendingSize` 的计算应包含待发送数据的大小和其 `Entry` 实例对象的内存占用大小，这样才能准确计算出 `ChannelOutboundBuffer` 中待发送数据的内存占用总量。`ChannelOutboundBuffer` 中所有 `Entry` 实例中的 `pendingSize` 之和即为待发送数据的总内存占用量。

```java
public final class ChannelOutboundBuffer {
  //ChannelOutboundBuffer中的待发送数据的内存占用总量
  private volatile long totalPendingSize;

}
```

#### 高低水位线

上小节提到 Netty 为了防止 ChannelOutboundBuffer 中的待发送数据内存占用无限制的增长从而导致 OOM ，所以引入了高低水位线，作为待发送数据内存占用的上限和下限。

**那么高低水位线具体设置多大呢** ? 我们来看一下 DefaultChannelConfig 中的配置。

```java
public class DefaultChannelConfig implements ChannelConfig {

    //ChannelOutboundBuffer中的高低水位线
    private volatile WriteBufferWaterMark writeBufferWaterMark = WriteBufferWaterMark.DEFAULT;

}
public final class WriteBufferWaterMark {

    private static final int DEFAULT_LOW_WATER_MARK = 32 * 1024;
    private static final int DEFAULT_HIGH_WATER_MARK = 64 * 1024;

    public static final WriteBufferWaterMark DEFAULT =
            new WriteBufferWaterMark(DEFAULT_LOW_WATER_MARK, DEFAULT_HIGH_WATER_MARK, false);

    WriteBufferWaterMark(int low, int high, boolean validate) {

        ..........省略校验逻辑.........

        this.low = low;
        this.high = high;
    }
}
```

在 `ChannelOutboundBuffer` 中，**高水位线**和**低水位线**的设置分别为：

- **高水位线**：64 KB
  当每个 Channel 中的待发送数据超过 64 KB 时，Channel 的状态将变为 **不可写状态**。
- **低水位线**：32 KB
  当内存占用量低于 32 KB 时，Channel 的状态会再次变为 **可写状态**。

这种设计有效地管理了待发送数据的内存使用，确保在网络拥塞或负载过高的情况下，不会导致内存溢出（OOM）问题的发生。

#### Entry 实例对象在 JVM 中占用内存大小

`pendingSize` 主要用于记录当前待发送数据的内存占用总量，以预警 OOM（Out of Memory）问题的发生。待发送数据的内存占用由以下两部分组成：

- **待发送数据** `msg` **的内存占用大小**
- `Entry` **对象本身在 JVM 中的内存占用**

如何计算 `Entry` 对象的内存占用？

要理解 `Entry` 对象的内存占用，我们需要首先了解 Java 对象的内存布局相关知识。关于这方面的详细信息，笔者已在《一文聊透对象在 JVM 中的内存布局，以及内存对齐和压缩指针的原理及应用》一文中进行了阐述，感兴趣的同学可以参考这篇文章。以下是一些关于计算 Java 对象占用内存大小的关键信息：

普通 Java 对象的内存布局由以下三部分组成：

1. **对象头**
2. **实例数据区**
3. **Padding（填充）**

**对象头**：包含对象运行时信息的 `MarkWord` 和指向对象类型元信息的类型指针。

- **MarkWord**：用于存放 `hashcode`、GC 分代年龄、锁状态标志、线程持有的锁、偏向线程 ID 和偏向时间戳等。在 32 位操作系统中，`MarkWord` 占用 4B；在 64 位操作系统中占用 8B。
- **类型指针**：指向对象的类型信息。在 64 位系统中，如果开启压缩指针（`-XX:+UseCompressedOops`），占用 4B；如果关闭压缩指针（`-XX:-UseCompressedOops`），占用 8B。

**实例数据区**：存储 Java 类中定义的实例字段，包括所有父类中的实例字段及对象引用。

在实例数据区中，对象字段之间的排列及内存对齐需遵循以下规则：

1. **规则 1**：如果一个字段占用 `X` 个字节，则该字段的偏移量 `OFFSET` 需对齐至 `NX`。
2. **规则 2**：在开启压缩指针的 64 位 JVM 中，Java 类中的第一个字段的 `OFFSET` 需对齐至 `4N`；在关闭压缩指针的情况下需对齐至 `8N`。
3. **规则 3**：JVM 默认分配字段的顺序为：`long/double`、`int/float`、`short/char`、`byte/boolean`、`oops`（Ordinary Object Pointer）。父类中定义的实例变量会出现在子类实例变量之前。当设置 JVM 参数 `-XX:+CompactFields` 时（默认），占用内存小于 `long/double` 的字段可以被插入到第一个 `long/double` 字段之前的间隙中，以避免不必要的内存填充。

**内存对齐**：Java 虚拟机堆中对象的起始地址需对齐至 8 的倍数（可通过 JVM 参数 `-XX:ObjectAlignmentInBytes` 控制，默认为 8）。

在了解上述字段排列和内存对齐规则后，我们将分别分析在开启压缩指针和关闭压缩指针情况下的 `Entry` 对象内存布局，并计算其内存占用大小。

```java
static final class Entry {
    .............省略static字段RECYCLER.........

    //DefaultHandle用于回收对象
    private final Handle<Entry> handle;
    //ChannelOutboundBuffer下一个节点
    Entry next;
    //待发送数据
    Object msg;
    //msg 转换为 jdk nio 中的byteBuffer
    ByteBuffer[] bufs;
    ByteBuffer buf;
    //异步write操作的future
    ChannelPromise promise;
    //已发送了多少
    long progress;
    //总共需要发送多少，不包含entry对象大小。
    long total;
    //pendingSize表示entry对象在堆中需要的内存总量 待发送数据大小 + entry对象本身在堆中占用内存大小（96）
    int pendingSize;
    //msg中包含了几个jdk nio bytebuffer
    int count = -1;
    //write操作是否被取消
    boolean cancelled;
}
```

我们看到 Entry 对象中一共有 11 个实例字段，其中 2 个 long 型字段，2 个 int 型字段，1 个 boolean 型字段，6 个对象引用。

默认情况下 JVM 参数 `-XX +CompactFields` 是开启的。

**开启指针压缩 -XX:+UseCompressedOops**

![image-20241031181435955](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311814042.png)

Entry 对象的内存布局中开头先是 8 个字节的 MarkWord，然后是 4 个字节的类型指针（开启压缩指针）。

在实例数据区中对象的排列规则需要符合规则 3，也就是字段之间的排列顺序需要遵循 `long > int > boolean > oop(对象引用)`。

根据规则 3 Entry 对象实例数据区第一个字段应该是 long progress，但根据规则 1 long 型字段的 OFFSET 需要对齐至 8 的倍数，并且根据 规则 2 在开启压缩指针的情况下，对象的第一个字段 OFFSET 需要对齐至 4 的倍数。所以字段 long progress 的 OFFET = 16，这就必然导致了在对象头与字段 long progress 之间需要由 4 字节的字节填充（OFFET = 12 处发生字节填充）。

但是 JVM 默认开启了 `-XX +CompactFields`，根据 规则 3 占用内存小于 long / double 的字段会允许被插入到对象中第一个 long / double 字段之前的间隙中，以避免不必要的内存填充。

所以位于后边的字段 int pendingSize 插入到了 OFFET = 12 位置处，避免了不必要的字节填充。

在 Entry 对象的实例数据区中紧接着基础类型字段后面跟着的就是 6 个对象引用字段(开启压缩指针占用 4 个字节)。

大家一定注意到 OFFSET = 37 处本应该存放的是字段 `private final Handle<Entry> handle` 但是却被填充了 3 个字节。这是为什么呢？

根据字段重排列规则 1：引用字段 `private final Handle<Entry> handle` 占用 4 个字节（开启压缩指针的情况），所以需要对齐至 4 的倍数。所以需要填充 3 个字节，使得引用字段 `private final Handle<Entry> handle` 位于 OFFSET = 40 处。

**根据以上这些规则最终计算出来在开启压缩指针的情况下 Entry 对象在堆中占用内存大小为 64 字节**

#### 关闭指针压缩 -XX:-UseCompressedOops

在分析完 Entry 对象在开启压缩指针情况下的内存布局情况后，我想大家现在对前边介绍的字段重排列的三个规则理解更加清晰了，那么我们基于这个基础来分析下在关闭压缩指针的情况下 Entry 对象的内存布局。

![image-20241031181441106](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311934791.png)

首先 Entry 对象在内存布局中的开头依然是由 8 个字节的 MarkWord 还有 8 个字节的类型指针（关闭压缩指针）组成的对象头。

我们看到在 OFFSET = 41 处发生了字节填充，原因是在关闭压缩指针的情况下，对象引用占用内存大小变为 8 个字节，根据规则 1: 引用字段 `private final Handle<Entry> handle` 的 OFFET 需要对齐至 8 的倍数，所以需要在该引用字段之前填充 7 个字节，使得引用字段 `private final Handle<Entry> handle` 的 OFFET = 48 。

**综合字段重排列的三个规则最终计算出来在关闭压缩指针的情况下 Entry 对象在堆中占用内存大小为 96 字节**

#### 向 ChannelOutboundBuffer 中缓存待发送数据

在介绍完 `ChannelOutboundBuffer` 的基本结构之后，下面就来到了 Netty 处理 `write` 事件的最后一步，我们来看下用户的待发送数据是如何被添加进 `ChannelOutboundBuffer` 中的。

```java
public void addMessage(Object msg, int size, ChannelPromise promise) {
    Entry entry = Entry.newInstance(msg, size, total(msg), promise);
    if (tailEntry == null) {
        flushedEntry = null;
    } else {
        Entry tail = tailEntry;
        tail.next = entry;
    }
    tailEntry = entry;
    if (unflushedEntry == null) {
        unflushedEntry = entry;
    }

    incrementPendingOutboundBytes(entry.pendingSize, false);
}
```

##### 创建 Entry 对象来封装待发送数据信息

通过前面的介绍，我们了解到，当用户调用 `ctx.write(msg)` 之后，**write** 事件开始在 **pipeline** 中从当前 **ChannelHandler** 向前传播，最终在 **HeadContext** 中将待发送数据写入到对应的写缓冲区 **ChannelOutboundBuffer** 中。

**ChannelOutboundBuffer** 是由 **Entry** 结构组成的单链表，而 **Entry** 结构封装了用户待发送数据的各种信息。首先，我们需要为待发送数据创建 **Entry** 对象。

在《详解 Recycler 对象池的精妙设计与实现》一文中提到，Netty 作为一个高性能、高吞吐的网络框架，要面对海量的 IO 处理操作，这种场景下会频繁创建大量的 **Entry** 对象。对象的创建及其回收会带来性能开销，尤其是在频繁创建对象的场景下，这种开销会进一步被放大。因此，Netty 引入了对象池来管理 **Entry** 对象实例，以避免频繁创建 **Entry** 对象和 **GC** 带来的性能开销。

既然 **Entry** 对象已经被对象池接管，那么它在对象池外是不能被直接创建的，其构造函数是私有的，并提供一个静态方法 `newInstance` 供外部线程从对象池中获取 **Entry** 对象。这一点在《详解 Recycler 对象池的精妙设计与实现》一文中也有提到。

```java
static final class Entry {
    //静态变量引用类型地址 这个是在Klass Point(类型指针)中定义 8字节（开启指针压缩 为4字节）
    private static final ObjectPool<Entry> RECYCLER = ObjectPool.newPool(new ObjectCreator<Entry>() {
        @Override
        public Entry newObject(Handle<Entry> handle) {
            return new Entry(handle);
        }
    });

    //Entry对象只能通过对象池获取，不可外部自行创建
    private Entry(Handle<Entry> handle) {
        this.handle = handle;
    }

    //不考虑指针压缩的大小 entry对象在堆中占用的内存大小为96
    //如果开启指针压缩，entry对象在堆中占用的内存大小 会是64
    static final int CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD =
        SystemPropertyUtil.getInt("io.netty.transport.outboundBufferEntrySizeOverhead", 96);

    static Entry newInstance(Object msg, int size, long total, ChannelPromise promise) {
        Entry entry = RECYCLER.get();
        entry.msg = msg;
        //待发数据数据大小 + entry对象大小
        entry.pendingSize = size + CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD;
        entry.total = total;
        entry.promise = promise;
        return entry;
    }

    .......................省略................

}
```

1. 通过池化对象 Entry 中持有的对象池 RECYCLER ，从对象池中获取 Entry 对象实例。
2. 将用户待发送数据 msg（DirectByteBuffer），待发送数据大小：total ，本次发送数据的 channelFuture，以及该 Entry 对象的 pendingSize 统统封装在 Entry 对象实例的相应字段中。

这里需要特殊说明一点的是关于 pendingSize 的计算方式，之前我们提到 pendingSize 中所计算的内存占用一共包含两部分：

- 待发送网络数据大小
- Entry 对象本身在内存中的占用量

而在《3.3.4 Entry 实例对象在 JVM 中占用内存大小》小节中我们介绍到，Entry 对象在内存中的占用大小在开启压缩指针的情况下（-XX:+UseCompressedOops）占用 64 字节，在关闭压缩指针的情况下（-XX:-UseCompressedOops）占用 96 字节。

字段 `CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD ` 表示的就是 Entry 对象在内存中的占用大小，Netty 这里默认是 96 字节，当然如果我们的应用程序开启了指针压缩，我们可以通过 JVM 启动参数 `-D io.netty.transport.outboundBufferEntrySizeOverhead` 指定为 64 字节。

##### 将 Entry 对象添加进 ChannelOutboundBuffer 中

```java
if (tailEntry == null) {
    flushedEntry = null;
} else {
    Entry tail = tailEntry;
    tail.next = entry;
}
tailEntry = entry;
if (unflushedEntry == null) {
    unflushedEntry = entry;
}
```

在《3.3 ChannelOutboundBuffer》小节一开始，我们介绍了 ChannelOutboundBuffer 中最重要的三个指针，这里涉及到的两个指针分别是：

- `unflushedEntry` ：指向 ChannelOutboundBuffer 中第一个未被 flush 进 Socket 的待发送数据。用来指示 ChannelOutboundBuffer 的第一个节点。
- `tailEntry `：指向 ChannelOutboundBuffer 中最后一个节点。

通过 unflushedEntry 和 tailEntry 可以定位出待发送数据的范围。Channel 中的每一次 write 事件，最终都会将待发送数据插入到 ChannelOutboundBuffer 的尾结点处。

##### incrementPendingOutboundBytes

在将 Entry 对象添加进 ChannelOutboundBuffer 之后，就需要更新用于记录当前 ChannelOutboundBuffer 中关于待发送数据所占内存总量的水位线指示。

如果更新后的水位线超过了 Netty 指定的高水位线 `DEFAULT_HIGH_WATER_MARK = 64 * 1024`，则需要将当前 Channel 的状态设置为不可写，并在 pipeline 中传播 ChannelWritabilityChanged 事件，注意该事件是一个 inbound 事件。

![](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311814323.png)

```java
public final class ChannelOutboundBuffer {

   //ChannelOutboundBuffer中的待发送数据的内存占用总量 : 所有Entry对象本身所占用内存大小 + 所有待发送数据的大小
    private volatile long totalPendingSize;

    //水位线指针
    private static final AtomicLongFieldUpdater<ChannelOutboundBuffer> TOTAL_PENDING_SIZE_UPDATER =
            AtomicLongFieldUpdater.newUpdater(ChannelOutboundBuffer.class, "totalPendingSize");

    private void incrementPendingOutboundBytes(long size, boolean invokeLater) {
        if (size == 0) {
            return;
        }
        //更新总共待写入数据的大小
        long newWriteBufferSize = TOTAL_PENDING_SIZE_UPDATER.addAndGet(this, size);
        //如果待写入的数据 大于 高水位线 64 * 1024  则设置当前channel为不可写 由用户自己决定是否继续写入
        if (newWriteBufferSize > channel.config().getWriteBufferHighWaterMark()) {
            //设置当前channel状态为不可写，并触发fireChannelWritabilityChanged事件
            setUnwritable(invokeLater);
        }
    }

}
```

volatile 关键字在 Java 内存模型中只能保证变量的可见性，以及禁止指令重排序。但无法保证多线程更新的原子性，这里我们可以通过 AtomicLongFieldUpdater 来帮助 totalPendingSize 字段实现原子性的更新。

```java
// 0表示channel可写，1表示channel不可写
private volatile int unwritable;

private static final AtomicIntegerFieldUpdater<ChannelOutboundBuffer> UNWRITABLE_UPDATER =
        AtomicIntegerFieldUpdater.newUpdater(ChannelOutboundBuffer.class, "unwritable");

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

当 ChannelOutboundBuffer 中的内存占用水位线 totalPendingSize 已经超过高水位线时，调用该方法将当前 Channel 的状态设置为不可写状态。

unwritable == 0 表示当前 channel 可写，unwritable == 1 表示当前 channel 不可写。

channel 可以通过调用 isWritable 方法来判断自身当前状态是否可写。

```java
public boolean isWritable() {
    return unwritable == 0;
}
```

当 Channel 的状态是首次从可写状态变为不可写状态时，就会在 channel 对应的 pipeline 中传播 ChannelWritabilityChanged 事件。

```java
private void fireChannelWritabilityChanged(boolean invokeLater) {
    final ChannelPipeline pipeline = channel.pipeline();
    if (invokeLater) {
        Runnable task = fireChannelWritabilityChangedTask;
        if (task == null) {
            fireChannelWritabilityChangedTask = task = new Runnable() {
                @Override
                public void run() {
                    pipeline.fireChannelWritabilityChanged();
                }
            };
        }
        channel.eventLoop().execute(task);
    } else {
        pipeline.fireChannelWritabilityChanged();
    }
}
```

用户可以在自定义的 ChannelHandler 中实现 channelWritabilityChanged 事件回调方法，来针对 Channel 的可写状态变化做出不同的处理。

```java
public class EchoServerHandler extends ChannelInboundHandlerAdapter {

    @Override
    public void channelWritabilityChanged(ChannelHandlerContext ctx) throws Exception {

        if (ctx.channel().isWritable()) {
            ...........当前channel可写.........
        } else {
            ...........当前channel不可写.........
        }
    }

}
```

到这里 write 事件在 pipeline 中的传播，笔者就为大家介绍完了，下面我们来看下另一个重要的 flush 事件的处理过程。

## flush

从前面对 Netty 处理 **write** 事件的分析中，我们可以看到，当用户调用 `ctx.write(msg)` 方法时，Netty 只是将用户要发送的数据临时写入到对应的待发送缓冲队列 **ChannelOutboundBuffer** 中，并不会立即将数据写入 Socket。

在一次 **read** 事件完成后，我们会调用 `ctx.flush()` 方法，将 **ChannelOutboundBuffer** 中的待发送数据写入 Socket 的发送缓冲区，从而实现数据的发送。

```java
public class EchoServerHandler extends ChannelInboundHandlerAdapter {

    @Override
    public void channelReadComplete(ChannelHandlerContext ctx) {
        //本次OP_READ事件处理完毕
        ctx.flush();
    }

}
```

### flush 事件的传播

**Flush 事件** 和 **Write 事件** 一样，都是 outbound 事件，因此它们在 **pipeline** 中的传播方向都是从后往前。

触发 **flush** 事件传播的方式有两种：

- `channelHandlerContext.flush()`：该方法会从当前 **ChannelHandler** 开始，在 **pipeline** 中向前传播，直到 **headContext**。
- `channelHandlerContext.channel().flush()`：该方法会从 **pipeline** 的尾节点 **tailContext** 开始，向前传播，直到 **headContext**。

```java
abstract class AbstractChannelHandlerContext implements ChannelHandlerContext, ResourceLeakHint {

    @Override
    public ChannelHandlerContext flush() {
        //向前查找覆盖flush方法的Outbound类型的ChannelHandler
        final AbstractChannelHandlerContext next = findContextOutbound(MASK_FLUSH);
        //获取执行ChannelHandler的executor,在初始化pipeline的时候设置，默认为Reactor线程
        EventExecutor executor = next.executor();
        if (executor.inEventLoop()) {
            next.invokeFlush();
        } else {
            Tasks tasks = next.invokeTasks;
            if (tasks == null) {
                next.invokeTasks = tasks = new Tasks(next);
            }
            safeExecute(executor, tasks.invokeFlushTask, channel().voidPromise(), null, false);
        }

        return this;
    }

}
```

这里的逻辑与 **write** 事件传播的逻辑基本相同。首先，通过 `findContextOutbound(MASK_FLUSH)` 方法，从当前 **ChannelHandler** 开始，在 **pipeline** 中向前查找第一个实现 **flush** 事件回调方法的 **ChannelOutboundHandler** 类型的 **ChannelHandler**。请注意，这里传入的执行资格掩码为 `MASK_FLUSH`。

执行 **ChannelHandler** 中事件回调方法的线程必须是通过 `pipeline#addLast(EventExecutorGroup group, ChannelHandler... handlers)` 为 **ChannelHandler** 指定的 **executor**。如果不指定，默认的 **executor** 为 **channel** 绑定的 **reactor** 线程。

如果当前线程不是 **ChannelHandler** 指定的 **executor**，则需要将 `invokeFlush()` 方法的调用封装成 **Task**，并交给指定的 **executor** 执行。

#### 触发 nextChannelHandler 的 flush 方法回调

```java
private void invokeFlush() {
    if (invokeHandler()) {
        invokeFlush0();
    } else {
        //如果该ChannelHandler并没有加入到pipeline中则继续向前传递flush事件
        flush();
    }
}
```

与 **write** 事件的相关处理相似，在处理 **flush** 事件时，首先需要调用 `invokeHandler()` 方法来判断 `nextChannelHandler` 是否在 **pipeline** 中被正确初始化。

- 如果 `nextChannelHandler` 中的 `handlerAdded` 方法并未被回调，则只能跳过该 **ChannelHandler**，并调用 `ChannelHandlerContext#flush` 方法，继续向前传播 **flush** 事件。
- 如果 `nextChannelHandler` 中的 `handlerAdded` 方法已经被回调，说明该 **ChannelHandler** 在 **pipeline** 中已被正确初始化，则可以直接调用 `nextChannelHandler` 的 **flush** 事件回调方法。

```java
private void invokeFlush0() {
    try {
        ((ChannelOutboundHandler) handler()).flush(this);
    } catch (Throwable t) {
        invokeExceptionCaught(t);
    }
}
```

与 **write** 事件处理的不同之处在于，当调用 `nextChannelHandler` 的 **flush** 回调时，如果出现异常，会触发 `nextChannelHandler` 的 **exceptionCaught** 回调。

```java
private void invokeExceptionCaught(final Throwable cause) {
    if (invokeHandler()) {
        try {
            handler().exceptionCaught(this, cause);
        } catch (Throwable error) {
            if (logger.isDebugEnabled()) {
                logger.debug(....相关日志打印......);
            } else if (logger.isWarnEnabled()) {
                logger.warn(...相关日志打印......));
            }
        }
    } else {
        fireExceptionCaught(cause);
    }
}
```

而其他 outbound 类事件，比如 **write** 事件，在传播过程中发生异常时，只会回调通知相关的 **ChannelFuture**，并不会触发 **exceptionCaught** 事件的传播

### flush 事件的处理

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311742560.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031174210480" style="zoom:50%;" />

最终 flush 事件会在 pipeline 中一直向前传播至 HeadContext 中，并在 HeadContext 里调用 channel 的 unsafe 类完成 flush 事件的最终处理逻辑。

```java
final class HeadContext extends AbstractChannelHandlerContext {

    @Override
    public void flush(ChannelHandlerContext ctx) {
        unsafe.flush();
    }

}
```

下面就真正到了 Netty 处理 flush 事件的地方。

```java
protected abstract class AbstractUnsafe implements Unsafe {

   @Override
    public final void flush() {
        assertEventLoop();

        ChannelOutboundBuffer outboundBuffer = this.outboundBuffer;
        //channel以关闭
        if (outboundBuffer == null) {
            return;
        }
        //将flushedEntry指针指向ChannelOutboundBuffer头结点，此时变为即将要flush进Socket的数据队列
        outboundBuffer.addFlush();
        //将待写数据写进Socket
        flush0();
    }

}
```

#### ChannelOutboundBuffer#addFlush

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729695440431-57d102c6-5892-4c37-9d27-a47f5d8b6ade.png)

这里就到了真正要发送数据的时候了，在 addFlush 方法中会将 flushedEntry 指针指向 unflushedEntry 指针表示的第一个未被 flush 的 Entry 节点。并将 unflushedEntry 指针置为空，准备开始 flush 发送数据流程。

此时 ChannelOutboundBuffer 由待发送数据的缓冲队列变为了即将要 flush 进 Socket 的数据队列

这样在 flushedEntry 与 tailEntry 之间的 Entry 节点即为本次 flush 操作需要发送的数据范围。

```java
public void addFlush() {
    Entry entry = unflushedEntry;
    if (entry != null) {
        if (flushedEntry == null) {
            flushedEntry = entry;
        }
        do {
            flushed ++;
            //如果当前entry对应的write操作被用户取消，则释放msg，并降低channelOutboundBuffer水位线
            if (!entry.promise.setUncancellable()) {
                int pending = entry.cancel();
                decrementPendingOutboundBytes(pending, false, true);
            }
            entry = entry.next;
        } while (entry != null);

        // All flushed so reset unflushedEntry
        unflushedEntry = null;
    }
}
```

在 flush 发送数据流程开始时，数据的发送流程就不能被取消了，在这之前我们都是可以通过 ChannelPromise 取消数据发送流程的。

所以这里需要对 ChannelOutboundBuffer 中所有 Entry 节点包裹的 ChannelPromise 设置为不可取消状态。

```java
public interface Promise<V> extends Future<V> {

   /**
     * 设置当前future为不可取消状态
     *
     * 返回true的情况：
     * 1：成功的将future设置为uncancellable
     * 2：当future已经成功完成
     *
     * 返回false的情况：
     * 1：future已经被取消，则不能在设置 uncancellable 状态
     *
     */
    boolean setUncancellable();

}
```

如果这里的 setUncancellable() 方法返回 false 则说明在这之前用户已经将 ChannelPromise 取消掉了，接下来就需要调用 entry.cancel() 方法来释放为待发送数据 msg 分配的堆外内存。

```java
static final class Entry {
    //write操作是否被取消
    boolean cancelled;

    int cancel() {
        if (!cancelled) {
            cancelled = true;
            int pSize = pendingSize;

            // release message and replace with an empty buffer
            ReferenceCountUtil.safeRelease(msg);
            msg = Unpooled.EMPTY_BUFFER;

            pendingSize = 0;
            total = 0;
            progress = 0;
            bufs = null;
            buf = null;
            return pSize;
        }
        return 0;
    }

}
```

当 Entry 对象被取消后，就需要减少 ChannelOutboundBuffer 的内存占用总量的水位线 totalPendingSize。

```java
private static final AtomicLongFieldUpdater<ChannelOutboundBuffer> TOTAL_PENDING_SIZE_UPDATER =
        AtomicLongFieldUpdater.newUpdater(ChannelOutboundBuffer.class, "totalPendingSize");

//水位线指针.ChannelOutboundBuffer中的待发送数据的内存占用总量 : 所有Entry对象本身所占用内存大小 + 所有待发送数据的大小
private volatile long totalPendingSize;

private void decrementPendingOutboundBytes(long size, boolean invokeLater, boolean notifyWritability) {
    if (size == 0) {
        return;
    }

    long newWriteBufferSize = TOTAL_PENDING_SIZE_UPDATER.addAndGet(this, -size);
    if (notifyWritability && newWriteBufferSize < channel.config().getWriteBufferLowWaterMark()) {
        setWritable(invokeLater);
    }
}
```

当更新后的水位线低于低水位线 `DEFAULT_LOW_WATER_MARK = 32 * 1024` 时，就将当前 channel 设置为可写状态。

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

当 Channel 的状态是第一次从不可写状态变为可写状态时，Netty 会在 pipeline 中再次触发 ChannelWritabilityChanged 事件的传播。

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729695665205-c95b2eda-45e3-47a3-8386-564ee1239e08.png)

#### 发送数据前的最后检查 --- flush0

flush0 方法这里主要做的事情就是检查当 channel 的状态是否正常，如果 channel 状态一切正常，则调用 doWrite 方法发送数据

```java
protected abstract class AbstractUnsafe implements Unsafe {

    //是否正在进行 flush 操作
    private boolean inFlush0;

    protected void flush0() {
        if (inFlush0) {
            // Avoid re-entrance
            return;
        }

        final ChannelOutboundBuffer outboundBuffer = this.outboundBuffer;

        //channel 已经关闭或者 outboundBuffer 为空
        if (outboundBuffer == null || outboundBuffer.isEmpty()) {
            return;
        }

        inFlush0 = true;

        if (!isActive()) {
            try {
                if (!outboundBuffer.isEmpty()) {
                    if (isOpen()) {
                        //当前channel处于disConnected状态  通知promise 写入失败 并触发channelWritabilityChanged事件
                        outboundBuffer.failFlushed(new NotYetConnectedException(), true);
                    } else {
                       //当前channel处于关闭状态 通知promise 写入失败 但不触发channelWritabilityChanged事件
                       outboundBuffer.failFlushed(newClosedChannelException(initialCloseCause, "flush0()"), false);
                    }
                }
            } finally {
                inFlush0 = false;
            }
            return;
        }

        try {
            //写入Socket
            doWrite(outboundBuffer);
        } catch (Throwable t) {
            handleWriteError(t);
        } finally {
            inFlush0 = false;
        }
    }

}
```

- `outboundBuffer == null || outboundBuffer.isEmpty() ` ：如果 channel 已经关闭了或者对应写缓冲区中没有任何数据，那么就停止发送流程，直接 return。
- `!isActive()` ：如果当前 channel 处于非活跃状态，则需要调用 `outboundBuffer#failFlushed` 通知 ChannelOutboundBuffer 中所有待发送操作对应的 channelPromise 向用户线程报告发送失败。并将待发送数据 Entry 对象从 ChannelOutboundBuffer 中删除，并释放待发送数据空间，回收 Entry 对象实例。

还记得我们在[《处理 OP_ACCEPT 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_ACCEPT)一文中提到过的 NioSocketChannel 的 active 状态有哪些条件吗？？

```java
@Override
public boolean isActive() {
    SocketChannel ch = javaChannel();
    return ch.isOpen() && ch.isConnected();
}
```

NioSocketChannel 处于 active 状态的条件必须是当前 NioSocketChannel 是 open 的同时处于 connected 状态。

- `!isActive() && isOpen()`：说明当前 channel 处于 disConnected 状态，这时通知给用户 channelPromise 的异常类型为 NotYetConnectedException ,并释放所有待发送数据占用的堆外内存，如果此时内存占用量低于低水位线，则设置 channel 为可写状态，并触发 channelWritabilityChanged 事件。

当 channel 处于 disConnected 状态时，用户可以进行 write 操作但不能进行 flush 操作。

- `!isActive() && !isOpen()` ：说明当前 channel 处于关闭状态，这时通知给用户 channelPromise 的异常类型为 newClosedChannelException ，因为 channel 已经关闭，所以这里并不会触发 channelWritabilityChanged 事件。
- 当 channel 的这些异常状态校验通过之后，则调用 doWrite 方法将 ChannelOutboundBuffer 中的待发送数据写进底层 Socket 中。

##### ChannelOutboundBuffer#failFlushed

```java
public final class ChannelOutboundBuffer {

    private boolean inFail;

    void failFlushed(Throwable cause, boolean notify) {
        if (inFail) {
            return;
        }

        try {
            inFail = true;
            for (;;) {
                if (!remove0(cause, notify)) {
                    break;
                }
            }
        } finally {
            inFail = false;
        }
    }
}
```

该方法用于在 Netty 在发送数据的时候，如果发现当前 channel 处于非活跃状态，则将 ChannelOutboundBuffer 中 flushedEntry 与 tailEntry 之间的 Entry 对象节点全部删除，并释放发送数据占用的内存空间，同时回收 Entry 对象实例。

##### ChannelOutboundBuffer#remove0

```java
private boolean remove0(Throwable cause, boolean notifyWritability) {
    Entry e = flushedEntry;
    if (e == null) {
        //清空当前reactor线程缓存的所有待发送数据
        clearNioBuffers();
        return false;
    }
    Object msg = e.msg;

    ChannelPromise promise = e.promise;
    int size = e.pendingSize;
    //从channelOutboundBuffer中删除该Entry节点
    removeEntry(e);

    if (!e.cancelled) {
        // only release message, fail and decrement if it was not canceled before.
        //释放msg所占用的内存空间
        ReferenceCountUtil.safeRelease(msg);
        //编辑promise发送失败，并通知相应的Lisener
        safeFail(promise, cause);
        //由于msg得到释放，所以需要降低channelOutboundBuffer中的内存占用水位线，并根据notifyWritability决定是否触发ChannelWritabilityChanged事件
        decrementPendingOutboundBytes(size, false, notifyWritability);
    }

    // recycle the entry
    //回收Entry实例对象
    e.recycle();

    return true;
}
```

一个 Entry 节点需要从 ChannelOutboundBuffer 中清除时，Netty 需要释放该 Entry 节点中包裹的发送数据 msg 所占用的内存空间。并标记对应的 promise 为失败同时通知对应的 listener ，由于 msg 得到释放，所以需要降低 channelOutboundBuffer 中的内存占用水位线，并根据 `boolean notifyWritability` 决定是否触发 ChannelWritabilityChanged 事件。最后需要将该 Entry 实例回收至 Recycler 对象池中。

## 将数据写入 IO

我们现在进入了 Netty 发送数据的核心处理逻辑。在[《处理 OP_READ 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_READ)一文中，笔者详细介绍了 Netty 读取数据的核心流程。Netty 会在一个 `read loop` 中不断循环读取 Socket 中的数据，直到数据读取完毕或读取次数已满 `16 次`。当循环读取了 `16 次` 仍未读取完毕时，Netty 将停止继续读取，因为它需要保证 `Reactor` 线程能够均匀地处理注册在其上的所有 `Channel` 的 IO 事件。剩余未读取的数据将等待下一次 `read loop` 开始读取。

此外，在每次 `read loop` 开始之前，Netty 会分配一个初始化大小为 `2048` 的 `DirectByteBuffer` 来装载从 Socket 中读取的数据。当整个 `read loop` 结束时，会根据本次读取数据的总量来判断是否需要对该 `DirectByteBuffer` 进行扩容或缩容，目的是为下一次 `read loop` 分配一个容量合适的 `DirectByteBuffer`。

实际上，Netty 对发送数据的处理与对读取数据的处理的核心逻辑是相似的，大家可以结合这两篇文章进行对比。但发送数据的细节较多且复杂一些。由于这部分逻辑整体稍微复杂，我们接下来将分模块进行解析：

### 发送数据前的准备工作

```java
@Override
protected void doWrite(ChannelOutboundBuffer in) throws Exception {
    //获取NioSocketChannel中封装的jdk nio底层socketChannel
    SocketChannel ch = javaChannel();
    //最大写入次数 默认为16 目的是为了保证SubReactor可以平均的处理注册其上的所有Channel
    int writeSpinCount = config().getWriteSpinCount();
    do {
        if (in.isEmpty()) {
            // 如果全部数据已经写完 则移除OP_WRITE事件并直接退出writeLoop
            clearOpWrite();
            return;
        }

        //  SO_SNDBUF设置的发送缓冲区大小 * 2 作为 最大写入字节数  293976 = 146988 << 1
        int maxBytesPerGatheringWrite = ((NioSocketChannelConfig) config).getMaxBytesPerGatheringWrite();
        // 将ChannelOutboundBuffer中缓存的DirectBuffer转换成JDK NIO 的 ByteBuffer
        ByteBuffer[] nioBuffers = in.nioBuffers(1024, maxBytesPerGatheringWrite);
        // ChannelOutboundBuffer中总共的DirectBuffer数
        int nioBufferCnt = in.nioBufferCount();

        switch (nioBufferCnt) {
            .........向底层jdk nio socketChannel发送数据.........
        }
    } while (writeSpinCount > 0);

    ............处理本轮write loop未写完的情况.......
}
```

这部分内容为 Netty 开始发送数据之前的准备工作：

1. **获取 write loop 最大发送循环次数**

从当前 NioSocketChannel 的配置类 NioSocketChannelConfig 中获取 write loop 最大循环写入次数，默认为 16。但也可以通过下面的方式进行自定义设置。

```java
ServerBootstrap b = new ServerBootstrap();
    b.group(bossGroup, workerGroup)
           .......
     .childOption(ChannelOption.WRITE_SPIN_COUNT,自定义数值)
```

2. **处理在一轮 write loop 中就发送完数据的情况**

进入 write loop 之后首先需要判断当前 ChannelOutboundBuffer 中的数据是否已经写完了 `in.isEmpty())` ，如果全部写完就需要清除当前 Channel 在 Reactor 上注册的 OP_WRITE 事件。

这里大家可能会有疑问，目前我们还没有注册 OP_WRITE 事件到 Reactor 上，为啥要清除呢？别着急，笔者会在后面为大家揭晓答案。

3. **获取本次 write loop 最大允许发送字节数**

从 ChannelConfig 中获取本次 write loop 最大允许发送的字节数 maxBytesPerGatheringWrite 。初始值为 `SO_SNDBUF大小 * 2 = 293976 = 146988 << 1`，最小值为 2048。

```java
private final class NioSocketChannelConfig extends DefaultSocketChannelConfig {
    //293976 = 146988 << 1
    //SO_SNDBUF设置的发送缓冲区大小 * 2 作为 最大写入字节数
    //最小值为2048
    private volatile int maxBytesPerGatheringWrite = Integer.MAX_VALUE;
    private NioSocketChannelConfig(NioSocketChannel channel, Socket javaSocket) {
        super(channel, javaSocket);
        calculateMaxBytesPerGatheringWrite();
    }

    private void calculateMaxBytesPerGatheringWrite() {
        // 293976 = 146988 << 1
        // SO_SNDBUF设置的发送缓冲区大小 * 2 作为 最大写入字节数
        int newSendBufferSize = getSendBufferSize() << 1;
        if (newSendBufferSize > 0) {
            setMaxBytesPerGatheringWrite(newSendBufferSize);
        }
    }
}
```

我们可以通过如下的方式自定义配置 Socket 发送缓冲区大小。

```java
ServerBootstrap b = new ServerBootstrap();
    b.group(bossGroup, workerGroup)
           .......
     .childOption(ChannelOption.SO_SNDBUF,自定义数值)
```

4. **将待发送数据转换成 JDK NIO ByteBuffer**

由于最终 Netty 会调用 JDK NIO 的 **SocketChannel** 来发送数据，因此需要首先将当前 **Channel** 中的写缓冲队列 **ChannelOutboundBuffer** 里存储的 **DirectByteBuffer**（Netty 中的 **ByteBuffer** 实现）转换为 JDK NIO 的 **ByteBuffer** 类型。最终，转换后的待发送数据将存储在 **ByteBuffer[] nioBuffers** 数组中。这一转换通过调用 `ChannelOutboundBuffer#nioBuffers` 方法完成。

- **maxBytesPerGatheringWrite**：表示本次 **write loop** 中最多从 **ChannelOutboundBuffer** 中转换 `maxBytesPerGatheringWrite` 个字节。即本次 **write loop** 最多能发送的字节数。
- **1024**：表示本次 **write loop** 最多转换 1024 个 **ByteBuffer**（JDK NIO 实现）。这意味着本次 **write loop** 最多批量发送的 **ByteBuffer** 数量。

通过 `ChannelOutboundBuffer#nioBufferCount()` 获取本次 **write loop** 总共需要发送的 **ByteBuffer** 数量 **nioBufferCnt**。请注意，这里已经变成了 JDK NIO 实现的 **ByteBuffer**。

详细的 ByteBuffer 类型转换过程，笔者会在专门讲解 Buffer 设计的时候为大家全面细致地讲解，这里我们还是主要聚焦于发送数据流程的主线。

当做完这些发送前的准备工作之后，接下来 Netty 就开始向 JDK NIO SocketChannel 发送这些已经转换好的 JDK NIO ByteBuffer 了。

### 向 JDK NIO SocketChannel 发送数据

![image-20241031181631089](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311816248.png)

```java
@Override
protected void doWrite(ChannelOutboundBuffer in) throws Exception {
    SocketChannel ch = javaChannel();
    int writeSpinCount = config().getWriteSpinCount();
    do {

        //.........将待发送数据转换到JDK NIO ByteBuffer中.........

        //本次 write loop 中需要发送的 JDK ByteBuffer 个数
        int nioBufferCnt = in.nioBufferCount();

        switch (nioBufferCnt) {
            case 0:
                //这里主要是针对 网络传输文件数据 的处理 FileRegion
                writeSpinCount -= doWrite0(in);
                break;
            case 1: {
                .........处理单个NioByteBuffer发送的情况......
                break;
            }
            default: {
                .........批量处理多个NioByteBuffers发送的情况......
                break;
            }
        }
    } while (writeSpinCount > 0);

    ............处理本轮write loop未写完的情况.......
}
```

大家可能会对 `nioBufferCnt == 0` 的情况感到疑惑。明明之前已经校验过 `ChannelOutboundBuffer` 不为空，为什么这里从 `ChannelOutboundBuffer` 中获取到的 `nioBuffer` 个数依然为 0 呢？

在之前介绍 Netty 对 `write` 事件的处理过程中提到，`ChannelOutboundBuffer` 只支持 `ByteBuf` 类型和 `FileRegion` 类型。其中，`ByteBuf` 类型用于装载普通的发送数据，而 `FileRegion` 类型则用于通过零拷贝的方式进行网络传输文件。

虽然此时 `ChannelOutboundBuffer` 不为空，但装载的 `NioByteBuffer` 个数为 0，这表明 `ChannelOutboundBuffer` 中装载的是 `FileRegion` 类型，当前正在进行网络文件传输。`case 0` 的分支主要用于处理网络文件传输的情况。

#### 零拷贝发送网络文件

```java
protected final int doWrite0(ChannelOutboundBuffer in) throws Exception {
    Object msg = in.current();
    if (msg == null) {
        return 0;
    }
    return doWriteInternal(in, in.current());
}
```

这里需要特别注意的是用于文件传输的方法 doWriteInternal 中的返回值，理解这些返回值的具体情况有助于我们理解后面 write loop 的逻辑走向。

```java
private int doWriteInternal(ChannelOutboundBuffer in, Object msg) throws Exception {

    if (msg instanceof ByteBuf) {

         ..............忽略............

    } else if (msg instanceof FileRegion) {
        FileRegion region = (FileRegion) msg;
        //文件已经传输完毕
        if (region.transferred() >= region.count()) {
            in.remove();
            return 0;
        }

        //零拷贝的方式传输文件
        long localFlushedAmount = doWriteFileRegion(region);
        if (localFlushedAmount > 0) {
            in.progress(localFlushedAmount);
            if (region.transferred() >= region.count()) {
                in.remove();
            }
            return 1;
        }
    } else {
        // Should not reach here.
        throw new Error();
    }
    //走到这里表示 此时Socket已经写不进去了 退出writeLoop，注册OP_WRITE事件
    return WRITE_STATUS_SNDBUF_FULL;
}
```

最终会在 doWriteFileRegion 方法中通过 `FileChannel#transferTo` 方法底层用到的系统调用为 `sendFile` 实现零拷贝网络文件的传输。

```java
public class NioSocketChannel extends AbstractNioByteChannel implements io.netty.channel.socket.SocketChannel {

   @Override
    protected long doWriteFileRegion(FileRegion region) throws Exception {
        final long position = region.transferred();
        return region.transferTo(javaChannel(), position);
    }

}
```

关于 Netty 中涉及到的零拷贝，笔者会有一篇专门的文章为大家讲解，本文的主题我们还是先聚焦于把发送流程的主线打通。

我们继续回到发送数据流程主线上来~~

```java
case 0:
    //这里主要是针对 网络传输文件数据 的处理 FileRegion
    writeSpinCount -= doWrite0(in);
    break;
```

- `region.transferred() >= region.count()` ：表示当前 FileRegion 中的文件数据已经传输完毕。那么在这种情况下本次 write loop 没有写入任何数据到 Socket ，所以返回 0 ，writeSpinCount - 0 意思就是本次 write loop 不算，继续循环。
- `localFlushedAmount > 0` ：表示本 write loop 中写入了一些数据到 Socket 中，会有返回 1，writeSpinCount - 1 减少一次 write loop 次数。
- `localFlushedAmount <= 0` ：表示当前 Socket 发送缓冲区已满，无法写入数据，那么就返回 `WRITE_STATUS_SNDBUF_FULL = Integer.MAX_VALUE`。`writeSpinCount - Integer.MAX_VALUE` 必然是负数，直接退出循环，向 Reactor 注册 OP_WRITE 事件并退出 flush 流程。等 Socket 发送缓冲区可写了，Reactor 会通知 channel 继续发送文件数据。**记住这里，我们后面还会提到**。

#### 发送普通数据

在处理 ByteBuffer 装载的普通数据发送逻辑时，剩下的两个 case：`case 1` 和 `default` 分支主要负责不同的情况。

1. `case 1`

此分支表示当前 `Channel` 的 `ChannelOutboundBuffer` 中仅包含一个 `NioByteBuffer` 的情况。

2. `default`

此分支表示当前 `Channel` 的 `ChannelOutboundBuffer` 中包含多个 `NioByteBuffer` 的情况。

```java
@Override
protected void doWrite(ChannelOutboundBuffer in) throws Exception {
    SocketChannel ch = javaChannel();
    int writeSpinCount = config().getWriteSpinCount();
    do {

        .........将待发送数据转换到JDK NIO ByteBuffer中.........

        //本次write loop中需要发送的 JDK ByteBuffer个数
        int nioBufferCnt = in.nioBufferCount();

        switch (nioBufferCnt) {
            case 0:
                  ..........处理网络文件传输.........
            case 1: {
                ByteBuffer buffer = nioBuffers[0];
                int attemptedBytes = buffer.remaining();
                final int localWrittenBytes = ch.write(buffer);
                if (localWrittenBytes <= 0) {
                    //如果当前Socket发送缓冲区满了写不进去了，则注册OP_WRITE事件，等待Socket发送缓冲区可写时 在写
                    // SubReactor在处理OP_WRITE事件时，直接调用flush方法
                    incompleteWrite(true);
                    return;
                }
                //根据当前实际写入情况调整 maxBytesPerGatheringWrite数值
                adjustMaxBytesPerGatheringWrite(attemptedBytes, localWrittenBytes, maxBytesPerGatheringWrite);
                //如果ChannelOutboundBuffer中的某个Entry被全部写入 则删除该Entry
                // 如果Entry被写入了一部分 还有一部分未写入  则更新Entry中的readIndex 等待下次writeLoop继续写入
                in.removeBytes(localWrittenBytes);
                --writeSpinCount;
                break;
            }
            default: {
                // ChannelOutboundBuffer中总共待写入数据的字节数
                long attemptedBytes = in.nioBufferSize();
                //批量写入
                final long localWrittenBytes = ch.write(nioBuffers, 0, nioBufferCnt);
                if (localWrittenBytes <= 0) {
                    incompleteWrite(true);
                    return;
                }
                //根据实际写入情况调整一次写入数据大小的最大值
                // maxBytesPerGatheringWrite决定每次可以从channelOutboundBuffer中获取多少发送数据
                adjustMaxBytesPerGatheringWrite((int) attemptedBytes, (int) localWrittenBytes,
                        maxBytesPerGatheringWrite);
                //移除全部写完的BUffer，如果只写了部分数据则更新buffer的readerIndex，下一个writeLoop写入
                in.removeBytes(localWrittenBytes);
                --writeSpinCount;
                break;
            }
        }
    } while (writeSpinCount > 0);

    ............处理本轮write loop未写完的情况.......
}
```

`case 1` 和 `default` 这两个分支在处理发送数据时的逻辑是相同的，唯一的区别在于：

- `case 1`：处理单个 `NioByteBuffer` 的发送。
- `default`：批量处理多个 `NioByteBuffer` 的发送。

下面将以经常被触发的 `default` 分支为例，讲述 Netty 在处理数据发送时的逻辑细节：

1. **获取字节总量**
   首先，从当前 `NioSocketChannel` 中的 `ChannelOutboundBuffer` 获取本次写循环（write loop）需要发送的字节总量 `attemptedBytes`。这个 `nioBufferSize` 是在前面介绍的 `ChannelOutboundBuffer#nioBuffers` 方法中转换 JDK NIO `ByteBuffer` 类型时计算出来的。
2. **批量发送数据**
   调用 JDK NIO 原生 `SocketChannel` 批量发送 `nioBuffers` 中的数据，并获取本次写循环一共批量发送的字节数 `localWrittenBytes`。
3. **处理写缓冲区满的情况**
   如果 `localWrittenBytes <= 0`，则表示当前 Socket 的写缓存区 `SEND_BUF` 已满，无法写入数据。此时，需要向当前 `NioSocketChannel` 对应的 Reactor 注册 `OP_WRITE` 事件，并停止当前的 flush 流程。当 Socket 的写缓冲区有容量可写时，`epoll` 将通知 reactor 线程继续写入。

```java
/**
 * @throws  NotYetConnectedException
 *          If this channel is not yet connected
 */
public abstract long write(ByteBuffer[] srcs, int offset, int length)
    throws IOException;
protected final void incompleteWrite(boolean setOpWrite) {
    // Did not write completely.
    if (setOpWrite) {
        //这里处理还没写满16次 但是socket缓冲区已满写不进去的情况 注册write事件
        //什么时候socket可写了， epoll会通知reactor线程继续写
        setOpWrite();
    } else {
          ...........目前还不需要关注这里.......
    }
}
```

向 Reactor 注册 OP_WRITE 事件：

```java
protected final void setOpWrite() {
    final SelectionKey key = selectionKey();
    if (!key.isValid()) {
        return;
    }
    final int interestOps = key.interestOps();
    if ((interestOps & SelectionKey.OP_WRITE) == 0) {
        key.interestOps(interestOps | SelectionKey.OP_WRITE);
    }
}
```

关于通过位运算来向 IO 事件集合 interestOps 添加监听 IO 事件的用法，在前边的文章中，笔者已经多次介绍过了，这里不再重复。

4. **调整下次写入字节数**
   根据本次写循环向 Socket 写缓冲区写入数据的情况，调整下次写循环的最大写入字节数。`maxBytesPerGatheringWrite` 决定每次写循环可以从 `channelOutboundBuffer` 中最多获取多少发送数据。其初始值为 `SO_SNDBUF` 大小的两倍，即 `293976 = 146988 << 1`，最小值为 `2048`。

```java
public static final int MAX_BYTES_PER_GATHERING_WRITE_ATTEMPTED_LOW_THRESHOLD = 4096;

private void adjustMaxBytesPerGatheringWrite(int attempted, int written, int oldMaxBytesPerGatheringWrite) {
    if (attempted == written) {
        if (attempted << 1 > oldMaxBytesPerGatheringWrite) {
            ((NioSocketChannelConfig) config).setMaxBytesPerGatheringWrite(attempted << 1);
        }
    } else if (attempted > MAX_BYTES_PER_GATHERING_WRITE_ATTEMPTED_LOW_THRESHOLD && written < attempted >>> 1) {
        ((NioSocketChannelConfig) config).setMaxBytesPerGatheringWrite(attempted >>> 1);
    }
}
```

由于操作系统会动态调整 `SO_SNDBUF` 的大小，所以这里 Netty 也需要根据操作系统的动态调整做出相应的调整，目的是尽量多地写入数据。

当 `attempted == written` 时，表示本次写循环 (`write loop`) 尝试写入的数据已全部成功写入到 Socket 的写缓冲区中，这意味着下次写循环应该尝试写入更多的数据。

**如何确定 “更多” 数据的具体量？**

- **扩大写入量**
  Netty 会将本次写入的数据量 `written` 扩大两倍。如果扩大后的写入量大于本次写循环的最大限制写入量 `maxBytesPerGatheringWrite`，这表明用户的写入需求非常高，Netty 将满足这一需求。因此，当前 `NioSocketChannelConfig` 中的 `maxBytesPerGatheringWrite` 将更新为本次写循环两倍的写入量。

  在下次写循环中，将尝试从 `ChannelOutboundBuffer` 中加载最多 `written * 2` 大小的字节数。

- **维持现有写入量**
  如果扩大后的写入量仍然小于等于本次写循环的最大限制写入量 `maxBytesPerGatheringWrite`，则说明用户的写入需求尚不算强烈，Netty 将继续维持当前的 `maxBytesPerGatheringWrite` 数值不变。

- **减少下次写入量**
  如果本次写入的数据量不足尝试写入数据的 `1/2`，即 `written < attempted >>> 1`，则表明当前 Socket 写缓冲区的可写容量已接近上限。此时，下次写循环应减少写入量，将下次写入的数据量减小为 `attempted` 的 `1/2`。不过，减少的量不能无限制下降，最小值不得低于 `2048`。

这里可以结合笔者的文章 ByteBuf 中介绍到的 `read loop` 场景中的扩缩容一起对比着看。

`read loop` 中的扩缩容触发时机是在一个完整的 `read loop` 结束时触发。而 `write loop` 中扩缩容的触发时机是在每次 `write loop` 发送完数据后，立即触发扩缩容判断。

5. **移除已发送数据**
   当本次写循环批量发送完 `ChannelOutboundBuffer` 中的数据后，最后调用 `in.removeBytes(localWrittenBytes)` 从 `ChannelOutboundBuffer` 中移除所有已完成的写入条目。如果只发送了条目的部分数据，则更新条目对象中封装的 `DirectByteBuffer` 的 `readerIndex`，以便等待下一次写循环的写入。

到这里，`write loop` 中的数据发送逻辑已介绍完毕。接下来，Netty 会在 `write loop` 中循环发送数据，直到满足以下条件之一：

- 写满 `16 次`。

- 数据发送完毕。

还有一种退出 `write loop` 的情况是，当 Socket 中的写缓冲区已满，无法继续写入数据。此时，Netty 将退出 `write loop` 并向 Reactor 注册 `OP_WRITE` 事件。

**特殊情况处理**

此外，存在一种特殊情况：如果 `write loop` 已经写满 `16 次` 但仍未写完所有数据，并且此时 Socket 的写缓冲区还没有满，Netty 会如何处理这种情况呢？

在这种情况下，Netty 会继续进行写入。具体而言，Netty 会根据当前写入的状态和缓冲区的容量动态调整写入策略，确保尽可能多地发送数据，而不会因为达到次数限制而停滞不前。

## 处理 Socket 可写但已经写满 16 次还没写完的情况

```java
@Override
protected void doWrite(ChannelOutboundBuffer in) throws Exception {
    SocketChannel ch = javaChannel();
    int writeSpinCount = config().getWriteSpinCount();
    do {

        .........将待发送数据转换到JDK NIO ByteBuffer中.........

        int nioBufferCnt = in.nioBufferCount();

        switch (nioBufferCnt) {
            case 0:
                //这里主要是针对 网络传输文件数据 的处理 FileRegion
                writeSpinCount -= doWrite0(in);
                break;
            case 1: {
                  .....发送单个nioBuffer....
            }
            default: {
                  .....批量发送多个nioBuffers......
            }
        }
    } while (writeSpinCount > 0);

    //处理write loop结束 但数据还没写完的情况
    incompleteWrite(writeSpinCount < 0);
}
```

当 `write loop` 结束后，`writeSpinCount` 的值会有两种情况：

- **`writeSpinCount < 0`**：这种情况可能较难理解。在前面介绍 Netty 通过零拷贝方式传输网络文件时，我们详细讨论了 `doWrite0` 方法的几种返回值。当 Netty 在传输文件的过程中发现 Socket 缓冲区已满，无法继续写入数据时，会返回 `WRITE_STATUS_SNDBUF_FULL = Integer.MAX_VALUE`。因此，`writeSpinCount` 的值将小于 0。

此时，`write loop` 将被中断，并跳转到 `incompleteWrite(writeSpinCount < 0)` 方法。在 `incompleteWrite` 方法中，Netty 会向 Reactor 注册 `OP_WRITE` 事件。当 Socket 缓冲区变得可写时，`epoll` 会通知 Reactor 线程继续发送文件。

```java
protected final void incompleteWrite(boolean setOpWrite) {
    // Did not write completely.
    if (setOpWrite) {
        //这里处理还没写满16次 但是socket缓冲区已满写不进去的情况 注册write事件
        // 什么时候socket可写了， epoll会通知reactor线程继续写
        setOpWrite();
    } else {
        ..............
    }
}
```

- **`writeSpinCount == 0`**：这种情况比较简单易懂。这表示已经写满了 `16 次`，但仍未写完，同时 Socket 的写缓冲区未满，依然可以继续写入。

尽管此时 Socket 仍可以继续写入，Netty 也不会再继续写入。这是因为执行 `flush` 操作的是 Reactor 线程，而 Reactor 线程负责执行注册在其上的所有 Channel 的 IO 操作。Netty 不允许 Reactor 线程长时间在一个 Channel 上执行 IO 操作，而是需要将执行时间均匀地分配到每个 Channel 上。因此，在这种情况下，Netty 会停止当前的写入操作，转而处理其他 Channel 上的 IO 事件。

**那么还没写完的数据，Netty 会如何处理呢**？

```java
protected final void incompleteWrite(boolean setOpWrite) {
    // Did not write completely.
    if (setOpWrite) {
        //这里处理还没写满16次 但是socket缓冲区已满写不进去的情况 注册write事件
        // 什么时候socket可写了， epoll会通知reactor线程继续写
        setOpWrite();
    } else {
        //这里处理的是socket缓冲区依然可写，但是写了16次还没写完，这时就不能在写了，reactor线程需要处理其他channel上的io事件

        //因为此时socket是可写的，必须清除op_write事件，否则会一直不停地被通知
        clearOpWrite();
        //如果本次writeLoop还没写完，则提交flushTask到reactor
        eventLoop().execute(flushTask);

    }
```

这个方法的 `if` 分支逻辑，在介绍 `do {.....} while()` 循环体的 `write loop` 发送逻辑时，我们提到过：在 `write loop` 循环发送数据的过程中，如果发现 Socket 缓冲区已满，无法继续写入数据（即 `localWrittenBytes <= 0`），则需要向 Reactor 注册 `OP_WRITE` 事件。等到 Socket 缓冲区变为可写状态时，`epoll` 会通知 Reactor 线程继续写入剩下的数据。

```java
do {
    .........将待发送数据转换到JDK NIO ByteBuffer中.........

    int nioBufferCnt = in.nioBufferCount();

    switch (nioBufferCnt) {
        case 0:
            writeSpinCount -= doWrite0(in);
            break;
        case 1: {
            .....发送单个nioBuffer....
            final int localWrittenBytes = ch.write(buffer);
            if (localWrittenBytes <= 0) {
                incompleteWrite(true);
                return;
            }
            .................省略..............
            break;
        }
        default: {
            .....批量发送多个nioBuffers......
            final long localWrittenBytes = ch.write(nioBuffers, 0, nioBufferCnt);
            if (localWrittenBytes <= 0) {
                incompleteWrite(true);
                return;
            }
            .................省略..............
            break;
        }
    }
} while (writeSpinCount > 0);
```

注意，`if` 分支处理的情况是还没写满 `16 次`，但是 Socket 缓冲区已满，无法写入的情况。

而 `else` 分支处理的是另一种情况：即 Socket 缓冲区是可写的，但已经写满 `16 次`，在本轮 `write loop` 中无法再继续写入。

在这种情况下，Netty 会将 Channel 中剩下的待写数据的 `flush` 操作封装成 `flushTask`，并将其放入 Reactor 的普通任务队列中。等待 Reactor 执行完其他 Channel 上的 IO 操作后，便会回过头来执行未写完的 `flush` 任务。

```java
private final Runnable flushTask = new Runnable() {
    @Override
    public void run() {
        ((AbstractNioUnsafe) unsafe()).flush0();
    }
};
```

这里我们看到 `flushTask` 中的任务是直接再次调用 `flush0`，继续回到发送数据的逻辑流程中。

::: warning 为什么使用 `flushTask` 而非注册 `OP_WRITE` 事件？原因如下

1. **Socket 缓冲区可写**：这里的 `else` 分支处理的是 Socket 缓冲区未满且可写的情况，但用户本次要发送的数据量过大，导致已经写了 `16 次` 但仍未写完。
2. **避免重复通知**：既然当前 Socket 缓冲区是可写的，注册 `OP_WRITE` 事件将导致一直收到 `epoll` 的通知。这是因为 JDK NIO Selector 默认使用的是 `epoll` 的水平触发模式。在这种模式下，只要 Socket 可写，`epoll` 就会不断通知 Reactor 线程，导致不必要的重复处理。

:::

因此，在这种情况下，唯一合理的做法是向 Reactor 提交 `flushTask`，以继续完成剩下数据的写入，而不是注册 `OP_WRITE` 事件。

注意：只有当 Socket 缓冲区已满导致无法写入时，Netty 才会去注册 `OP_WRITE` 事件。这与我们之前介绍的 `OP_ACCEPT` 事件和 `OP_READ` 事件的注册时机是不同的。

**这里大家可能还会有另一个疑问，就是为什么在向 Reactor 提交 `flushTask` 之前需要清理 `OP_WRITE` 事件呢？** 我们并没有注册 `OP_WRITE` 事件呀。

```java
protected final void incompleteWrite(boolean setOpWrite) {
    if (setOpWrite) {
        ......省略......
    } else {
        clearOpWrite();
        eventLoop().execute(flushTask);
    }
```

在为大家解答这个疑问之前，笔者先为大家介绍下 Netty 是如何处理 OP_WRITE 事件的，当大家明白了 OP_WRITE 事件的处理逻辑后，这个疑问就自然解开了。

## OP_WRITE 事件的处理

在[《核心引擎 Reactor 的运转架构》](/netty_source_code_parsing/main_task/event_scheduling_layer/reactor_dispatch)一文中，我们介绍过，当 Reactor 监听到 channel 上有 IO 事件发生后，最终会在 `processSelectedKey` 方法中处理 channel 上的 IO 事件。其中，`OP_ACCEPT` 事件和 `OP_READ` 事件的处理过程，笔者已经在之前的系列文章中介绍过了，这里我们聚焦于 `OP_WRITE` 事件的处理。

```java
public final class NioEventLoop extends SingleThreadEventLoop {

   private void processSelectedKey(SelectionKey k, AbstractNioChannel ch) {
        final AbstractNioChannel.NioUnsafe unsafe = ch.unsafe();

        .............省略.......

        try {
            int readyOps = k.readyOps();

            if ((readyOps & SelectionKey.OP_CONNECT) != 0) {
                  ......处理connect事件......
            }

            if ((readyOps & SelectionKey.OP_WRITE) != 0) {
                ch.unsafe().forceFlush();
            }

            if ((readyOps & (SelectionKey.OP_READ | SelectionKey.OP_ACCEPT)) != 0 || readyOps == 0) {
               ........处理accept和read事件.........
            }
        } catch (CancelledKeyException ignored) {
            unsafe.close(unsafe.voidPromise());
        }
    }

}
```

这里我们看到，当 `OP_WRITE` 事件发生后，Netty 直接调用 `channel` 的 `forceFlush` 方法。

```java
@Override
public final void forceFlush() {
    // directly call super.flush0() to force a flush now
    super.flush0();
}
```

其实 `forceFlush` 方法中并没有什么特殊的逻辑，它只是直接调用 `flush0` 方法，再次发起 `flush` 操作，以继续写入 `channel` 中剩下的数据。

```java
@Override
protected void doWrite(ChannelOutboundBuffer in) throws Exception {
    SocketChannel ch = javaChannel();
    int writeSpinCount = config().getWriteSpinCount();
    do {
        if (in.isEmpty()) {
            clearOpWrite();
            return;
        }
        .........将待发送数据转换到JDK NIO ByteBuffer中.........

        int nioBufferCnt = in.nioBufferCount();

        switch (nioBufferCnt) {
            case 0:
                  ......传输网络文件........
            case 1: {
                  .....发送单个nioBuffer....
            }
            default: {
                  .....批量发送多个nioBuffers......
            }
        }
    } while (writeSpinCount > 0);

    //处理write loop结束 但数据还没写完的情况
    incompleteWrite(writeSpinCount < 0);
}
```

在数据发送的过程中，`clearOpWrite()` 方法具有重要作用。当 `Channel` 上的 `OP_WRITE` 事件就绪时，表示此时 Socket 缓冲区已变为可写状态，Reactor 线程再次进入到 `flush` 流程中。

::: warning 清理 OP_WRITE 事件的必要性

- **数据全部写完**：当 `ChannelOutboundBuffer` 中的数据全部写完时（即 `in.isEmpty()`），需要调用 `clearOpWrite()` 方法以取消对 `OP_WRITE` 事件的监听。这是因为此时 Socket 缓冲区是可写的，若不取消监听，`epoll` 将不断通知 Reactor。
- **在 `incompleteWrite` 方法中的处理**：同理，在 `incompleteWrite` 方法的 `else` 分支中，也需要执行 `clearOpWrite()` 方法，以确保在 Socket 缓冲区可写的情况下取消对 `OP_WRITE` 事件的监听。

:::

```java
protected final void incompleteWrite(boolean setOpWrite) {

    if (setOpWrite) {
        // 这里处理还没写满16次 但是socket缓冲区已满写不进去的情况 注册write事件
        // 什么时候socket可写了， epoll会通知reactor线程继续写
        setOpWrite();
    } else {
        // 必须清除OP_WRITE事件，此时Socket对应的缓冲区依然是可写的，只不过当前channel写够了16次，被SubReactor限制了。
        // 这样SubReactor可以腾出手来处理其他channel上的IO事件。这里如果不清除OP_WRITE事件，则会一直被通知。
        clearOpWrite();

        //如果本次writeLoop还没写完，则提交flushTask到SubReactor
        //释放SubReactor让其可以继续处理其他Channel上的IO事件
        eventLoop().execute(flushTask);
    }
}
```

## writeAndFlush

在我们讲完 `write` 事件和 `flush` 事件的处理过程之后，`writeAndFlush` 就变得很简单了。它就是将 `write` 和 `flush` 流程结合起来，先触发 `write` 事件，然后再触发 `flush` 事件。

下面我们来看一下 `writeAndFlush` 的具体逻辑处理：

```java
public class EchoServerHandler extends ChannelInboundHandlerAdapter {

    @Override
    public void channelRead(final ChannelHandlerContext ctx, final Object msg) {
        //此处的msg就是Netty在read loop中从NioSocketChannel中读取到ByteBuffer
        ctx.writeAndFlush(msg);
    }
}
abstract class AbstractChannelHandlerContext implements ChannelHandlerContext, ResourceLeakHint {

    @Override
    public ChannelFuture writeAndFlush(Object msg) {
        return writeAndFlush(msg, newPromise());
    }

    @Override
    public ChannelFuture writeAndFlush(Object msg, ChannelPromise promise) {
        write(msg, true, promise);
        return promise;
    }

}
```

这里可以看到 `writeAndFlush` 方法的处理入口和 `write` 事件的处理入口是一样的。唯一不同的是，入口处理函数 `write` 方法的 `boolean flush` 入参不同，在 `writeAndFlush` 的处理中，`flush` 被设置为 `true`。

```java
private void write(Object msg, boolean flush, ChannelPromise promise) {
    ObjectUtil.checkNotNull(msg, "msg");

    ................省略检查promise的有效性...............

    //flush = true 表示channelHandler中调用的是writeAndFlush方法，这里需要找到pipeline中覆盖write或者flush方法的channelHandler
    //flush = false 表示调用的是write方法，只需要找到pipeline中覆盖write方法的channelHandler
    final AbstractChannelHandlerContext next = findContextOutbound(flush ?
            (MASK_WRITE | MASK_FLUSH) : MASK_WRITE);
    //用于检查内存泄露
    final Object m = pipeline.touch(msg, next);
    //获取下一个要被执行的channelHandler的executor
    EventExecutor executor = next.executor();
    //确保OutBound事件由ChannelHandler指定的executor执行
    if (executor.inEventLoop()) {
        //如果当前线程正是channelHandler指定的executor则直接执行
        if (flush) {
            next.invokeWriteAndFlush(m, promise);
        } else {
            next.invokeWrite(m, promise);
        }
    } else {
        //如果当前线程不是ChannelHandler指定的executor,则封装成异步任务提交给指定executor执行，注意这里的executor不一定是reactor线程。
        final WriteTask task = WriteTask.newInstance(next, m, promise, flush);
        if (!safeExecute(executor, task, promise, m, !flush)) {
            task.cancel();
        }
    }
}
```

由于在 `writeAndFlush` 流程的处理中，`flush` 标志被设置为 `true`，所以这里有两个地方会和 `write` 事件的处理有所不同。

- `findContextOutbound(MASK_WRITE | MASK_FLUSH)`：这里在 pipeline 中向前查找的 `ChannelOutboundHandler` 需要实现 `write` 方法或者 `flush` 方法。需要注意的是，`write` 方法和 `flush` 方法只需实现其中一个即可满足查找条件。因为一般我们自定义 `ChannelOutboundHandler` 时，都会继承 `ChannelOutboundHandlerAdapter` 类，而在 `ChannelInboundHandlerAdapter` 类中，对于这些 outbound 事件都会有默认的实现。

```java
public class ChannelOutboundHandlerAdapter extends ChannelHandlerAdapter implements ChannelOutboundHandler {

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

这样，在后面传播 `write` 事件或者 `flush` 事件时，我们通过上面的逻辑找出的 `ChannelOutboundHandler` 可能只实现了一个 `flush` 方法或者 `write` 方法。不过这样没关系，因为如果在传播 outbound 事件的过程中，发现找出的 `ChannelOutboundHandler` 中并没有实现对应的 outbound 事件回调函数，就会直接调用 `ChannelOutboundHandlerAdapter` 中的默认实现。

- 在向前传播 `writeAndFlush` 事件时，会通过调用 `ChannelHandlerContext` 的 `invokeWriteAndFlush` 方法，先传播 `write` 事件，然后再传播 `flush` 事件。

```java
void invokeWriteAndFlush(Object msg, ChannelPromise promise) {
    if (invokeHandler()) {
        //向前传递write事件
        invokeWrite0(msg, promise);
        //向前传递flush事件
        invokeFlush0();
    } else {
        writeAndFlush(msg, promise);
    }
}

private void invokeWrite0(Object msg, ChannelPromise promise) {
    try {
        //调用当前ChannelHandler中的write方法
        ((ChannelOutboundHandler) handler()).write(this, msg, promise);
    } catch (Throwable t) {
        notifyOutboundHandlerException(t, promise);
    }
}

private void invokeFlush0() {
    try {
        ((ChannelOutboundHandler) handler()).flush(this);
    } catch (Throwable t) {
        invokeExceptionCaught(t);
    }
}
```

在 `writeAndFlush` 方法的核心处理逻辑中，Netty 先向前传播 `write` 事件，然后在经过相应的 `write` 事件处理流程后，最后传播 `flush` 事件。以下是更详细的步骤：

1. **向前传播 `write` 事件**:
   - 当调用 `writeAndFlush` 方法时，Netty 会首先查找与当前 `Channel` 关联的 `ChannelOutboundHandler`。
   - 如果找到的处理器仅实现了 `flush` 方法而未实现 `write` 方法，这并不影响数据的发送。Netty 会自动调用 `ChannelOutboundHandlerAdapter` 中的默认 `write` 方法来处理该事件。
2. **传播 `flush` 事件**:
   - 紧接着，在处理完 `write` 事件后，Netty 会继续向前传播 `flush` 事件。
   - 类似于 `write` 事件的处理，若找到的处理器只实现了 `write` 方法而未实现 `flush` 方法，同样会调用父类 `ChannelOutboundHandlerAdapter` 中的默认实现，确保数据能够被正确刷新。

通过这种方式，Netty 保证了即使在处理器的实现不完整的情况下，数据也能够正确发送和刷新，从而保持了框架的灵活性和可扩展性。

## 总结

到这里，Netty 处理数据发送的整个完整流程，笔者就为大家详细介绍完了。可以看到，虽然 Netty 在处理读取数据和发送数据的过程中核心逻辑相似，但发送数据的过程明显细节更多且更复杂。

笔者将读取数据和发送数据的不同之处总结如下几点供大家回忆对比：

- **读取数据**：

  - 在每次 **read loop** 之前，会分配一个固定大小的 **DirectByteBuffer** 用于装载读取的数据。每轮 **read loop** 完全结束后，才会决定是否对下一轮读取过程分配的 **DirectByteBuffer** 进行扩容或缩容。

- **发送数据**：

  - 在每次 **write loop** 之前，都会获取本次 **write loop** 最大能够写入的字节数，根据这个最大写入字节数从 **ChannelOutboundBuffer** 中转换为 JDK NIO **ByteBuffer**。每次写入 **Socket** 之后都需要重新评估是否对这个最大写入字节数进行扩容或缩容。

- **循环次数**：

  - **read loop** 和 **write loop** 都被默认限制为最多执行 16 次。

- **循环结束策略**：

  - 在一个完整的 **read loop** 中，如果还未读取完数据，直接退出。等到 **Reactor** 线程执行完其他 **Channel** 上的 IO 事件后再读取未读完的数据。

  - 而在一个完整的

    write loop

    中，数据发送不完则分为两种情况：

    - **Socket** 缓冲区满，无法继续写入。这时需要向 **Reactor** 注册 **OP_WRITE** 事件。等 **Socket** 缓冲区变得可写时，`epoll` 通知 **Reactor** 线程继续发送。
    - **Socket** 缓冲区可写，但由于发送数据太多，导致虽然写满 16 次仍未写完。这时直接向 **Reactor** 丢一个 **flushTask**，等到 **Reactor** 线程执行完其他 **Channel** 上的 IO 事件后，再执行 **flushTask**。

- **事件注册**：

  - **OP_READ** 事件的注册是在 **NioSocketChannel** 被注册到对应的 **Reactor** 中时进行的。而 **OP_WRITE** 事件只会在 **Socket** 缓冲区满时才注册。当 **Socket** 缓冲区再次变得可写时，要记得取消 **OP_WRITE** 事件的监听，否则会一直被通知。

好了，本文的全部内容就到这里了，我们下篇文章见。
