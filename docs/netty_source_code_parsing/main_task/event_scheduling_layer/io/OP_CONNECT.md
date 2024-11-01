# 处理 OP_CONNECT 事件

## 前言

在 [《Socket 网络编程》](/netty_source_code_parsing/main_task/network_communication_layer/socket_network_programming) 中讲述了利用 Socket 编程进行双端 TCP 通信时的状态流程图

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301658323.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301658821.png)



在 Netty 中，客户端的 `connect` 操作与服务端的 `accept` 操作对应。具体来说，**`OP_CONNECT`** 事件是客户端的概念，也就是连接发起方的操作。当客户端触发 `OP_CONNECT` 事件时，说明第二次握手成功了。

然而，Netty 并不会阻塞等待握手完成。相反，当客户端调用 `connect` 方法时，它会在文件套接字上注册 **`OP_CONNECT`** 事件，然后 `Reactor` 线程可以去处理其他任务。当下次捕获到 `OP_CONNECT` 事件时，Netty 会完成 `Channel` 注册等相关操作。

在服务端，对应的事件是 **`OP_ACCEPT`**，在[《处理 OP_CONNECT 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_ACCEPT)会讲解。服务端的 `bind` 和 `listen` 操作由内核处理，应用层只需调用 `Socket` 的 `accept` 方法等待客户端连接。为了高效管理连接，Netty 的 `Main Reactor` 会在文件描述符上注册 **`OP_ACCEPT`** 事件，通过 I/O 多路复用来实现连接的接收。连接接收成功后，Main Reactor 会生成一个新的 `NioSocketChannel`，该通道负责此连接的通信，并注册到 `Sub Reactor` 中进行进一步的 I/O 处理。

本文仍基于 Netty 源码中的 `EchoClient` 示例，详细讲解 Netty 客户端如何与服务器建立连接。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301708700.png)

其实上述代码中那些 BootStrap 初始化逻辑我们在 [《BootStrap 初始化》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_init) 一文中已经说过了

本文的重点是红框中的代码

## 建立连接过程

在 Netty 中，客户端与服务器建立连接的过程可以通过以下关键步骤解析：

```java
ChannelFuture f = b.connect(HOST, PORT).sync();
```

这行代码的作用是同步阻塞当前线程，直到连接建立完成，也就是直到 **TCP 三次握手**成功。这背后其实是通过 Netty 的异步处理机制完成的。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301708330.png)

这行代码的作用是同步阻塞当前线程，直到连接建立完成，也就是直到 **TCP 三次握手**成功。这背后其实是通过 Netty 的异步处理机制完成的。

1. **初始化并注册 `Channel`**:
   - 调用 `initAndRegister()` 方法，会返回一个 `ChannelFuture` 对象。这个对象表示通道的注册操作，将注册操作提交给 `EventLoop` 执行。
   - 由于注册是异步任务，通过 `ChannelFuture` 可以获取任务的状态，如果任务未完成，会通过添加监听回调的方式在任务完成时触发执行。
2. **任务完成后的回调处理**:
   - 当 `initAndRegister` 的任务完成时，Netty 会执行连接操作 `doConnect0` 方法，建立到目标地址的连接。
   - 此方法会返回一个新的 `ChannelFuture` 实例，表示当前的连接操作，这也是 Netty 进行异步连接的重要机制。
3. **异步处理与回调**:
   - 在整个过程中，Netty 通过 `regFuture` 和 `promise`（Netty 自定义的 `Promise` 类）来管理任务的异步状态。
   - 这种异步设计能够显著提升性能，Netty 中的每一个 I/O 操作几乎都使用 `ChannelFuture` 或 `Promise` 来实现非阻塞的执行。

通过这种方式，Netty 结合 `EventLoop` 和异步回调机制，在 `connect()` 连接过程和 `Channel` 的初始化和注册阶段实现了完全非阻塞式的连接管理，从而提升了网络应用程序的并发处理能力。

### initAndRegister

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301709291.png)

上述方法的主要逻辑如下：

1. 创建并初始化 `NioSocketChannel`
2. 将由主线程创建好的 `NioSocketChannel` 注册到 Sub Reactor Group

关于 `NioSocketChannel` 的创建与初始化，这里可以先不用管，在[《处理 OP_ACCEPT 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_ACCEPT) 会详细说明

### doResolveAndConnect0

```java
if (regFuture.isDone()) {
    if (!regFuture.isSuccess()) {
        return regFuture;
    }
    return doResolveAndConnect0(channel, remoteAddress, localAddress, channel.newPromise());
} else {
    // Registration future is almost always fulfilled already, but just in case it's not.
    final PendingRegistrationPromise promise = new PendingRegistrationPromise(channel);
    regFuture.addListener(new ChannelFutureListener() {
        @Override
        public void operationComplete(ChannelFuture future) throws Exception {
            // Directly obtain the cause and do a null check so we only need one volatile read in case of a
            // failure.
            Throwable cause = future.cause();
            if (cause != null) {
                // Registration on the EventLoop failed so fail the ChannelPromise directly to not cause an
                // IllegalStateException once we try to access the EventLoop of the Channel.
                promise.setFailure(cause);
            } else {
                // Registration was successful, so set the correct executor to use.
                // See https://github.com/netty/netty/issues/2586
                promise.registered();
                doResolveAndConnect0(channel, remoteAddress, localAddress, promise);
            }
        }
    });
    return promise;
}
```

在上述代码中，我们可以清晰地看到 Netty 中高性能设计的影子：`regFuture.isDone()` 立即判断 `Channel` 是否初始化并注册完成。如果完成，则直接执行 `doResolveAndConnect0`；如果未完成，则将 `doResolveAndConnect0` 放入 `regFuture` 的监听器中。这种设计避免了任何 IO 阻塞，将 CPU 性能发挥到极致。

笔者认为这里似乎并没有显著的性能提升，因为在 `ChannelFuture f = b.connect(HOST, PORT).sync();` 这行代码处仍然会产生阻塞。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301719512.png)

#### 获取地址解析器 resolver

```java
AddressResolver<SocketAddress> resolver;
try {
    resolver = this.resolver.getResolver(eventLoop);
} catch (Throwable cause) {
    channel.close();
    return promise.setFailure(cause);
}
```

 通过 `resolver.getResolver(eventLoop)` 获取与事件循环绑定的地址解析器 `resolver`。  

#### 检查地址是否支持解析和已解析

```java
if (!resolver.isSupported(remoteAddress) || resolver.isResolved(remoteAddress)) {
    doConnect(remoteAddress, localAddress, promise);
    return promise;
}
```

- 检查解析器是否支持解析地址，或地址是否已解析。
- 如果地址已解析或解析器不支持此地址，则直接调用 `doConnect` 方法，否则跳过解析步骤，进行连接。

可以理解为如果是地址是域名，将其解析为IP地址，如果是IP地址，就不用解析了，直接进行连接

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301719495.png)

#### 异步解析地址

```java
final Future<SocketAddress> resolveFuture = resolver.resolve(remoteAddress);
```

- 调用 `resolver.resolve(remoteAddress)` 启动异步解析操作，返回一个 `resolveFuture` 对象，用于表示解析结果。
- 如果 `resolveFuture` 已完成（地址立即解析完成或有缓存），则立即处理解析结果；否则，将解析过程放入事件监听器中等待完成。

```java
if (resolveFuture.isDone()) {
    final Throwable resolveFailureCause = resolveFuture.cause();

    if (resolveFailureCause != null) {
        // Failed to resolve immediately
        channel.close();
        promise.setFailure(resolveFailureCause);
    } else {
        // Succeeded to resolve immediately; cached? (or did a blocking lookup)
        doConnect(resolveFuture.getNow(), localAddress, promise);
    }
    return promise;
}

// Wait until the name resolution is finished.
resolveFuture.addListener(new FutureListener<SocketAddress>() {
    @Override
    public void operationComplete(Future<SocketAddress> future) throws Exception {
        if (future.cause() != null) {
            channel.close();
            promise.setFailure(future.cause());
        } else {
            doConnect(future.getNow(), localAddress, promise);
        }
    }
});
```

- 如果 `resolveFuture` 已完成，通过 `resolveFuture.cause()` 检查解析是否失败：
  - 若失败，则关闭 `channel` 并设置 `promise` 为失败。
  - 若成功，调用 `doConnect` 方法使用解析后的地址进行连接。

- 如果 `resolveFuture` 尚未完成，则添加监听器 `FutureListener<SocketAddress>`。当解析完成时调用 `operationComplete` 方法：
  - 若解析失败，则关闭通道并设置 `promise` 为失败。
  - 若解析成功，使用解析后的地址调用 `doConnect` 方法进行连接。


#### doConnect

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301719482.png)

这里会进行一个简单的判断，确认是否指定了本机地址。可以注意到，此处的异步任务并未返回 `promise` 或 `Future`，因为此任务已不再是普通异步任务，而是依赖 `IO_CONNECT` 事件去触发后续流程，所以触发点不再需要 `promise` 或 `Future`，而是**被** IO 就绪事件所驱动。

从代码中可以看到，通道的连接操作被作为一个异步任务提交给 `channel` 注册的 `EventLoop` 来执行。在客户端代码中，通常不会指定 `localAddress`，因此继续跟踪 `channel.connect(remoteAddress, promise)` 会发现，`channel` 的连接操作通过 `pipeline` 实现。

这里调用了 `connect` 操作，执行了出站处理器在流水线中的步骤。不同于入站操作从头开始，出站操作 `connect` 是从流水线尾部开始执行的。类似入站逻辑，`pipeline` 会依次找到下一个出站处理器，并回调其 `connect` 方法（可以自行调试看此过程，这里不再赘述）。

**最终，CONNECT事件会到达 头结点`HeadContext`。**

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301718290.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301718299.png)

在头结点中，调用了一个`unsafe#connect(...)`。重点关注 doConnect 方法。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301718845.png)

##### 尝试连接

1. 调用 `isActive()` 检查通道的当前活动状态。

2. 尝试立即连接，`doConnect(remoteAddress, localAddress)` 返回 `true` 表示连接成功，直接调用 `fulfillConnectPromise(promise, wasActive)`，完成连接并更新状态。

3. 如果连接未完成（返回 `false`），说明处于非阻塞模式，将 `promise` 和 `remoteAddress` 记录为待处理连接的 `connectPromise` 和 `requestedRemoteAddress`。

###### NioSocketChannel.doConnect 

在尝试连接阶段会执行此方法

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301719197.png)

可见此处的connnect方法属于 `立即返回`

![image-20241101114321752](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411011143816.png)

当其返回 `false`，就说明当前未连接成功

然后会注册`OP_CONNECT`事件，等待被触发（希望你还记得我们之前讨论的触发点）

![image-20241101114325847](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411011143997.png)

但是这个等待触发也是有时长限制的！

##### 连接超时管理

```java
int connectTimeoutMillis = config().getConnectTimeoutMillis();
if (connectTimeoutMillis > 0) {
    connectTimeoutFuture = eventLoop().schedule(new Runnable() {
        @Override
        public void run() {
            ChannelPromise connectPromise = AbstractNioChannel.this.connectPromise;
            if (connectPromise != null && !connectPromise.isDone()
                    && connectPromise.tryFailure(new ConnectTimeoutException(
                            "connection timed out: " + remoteAddress))) {
                close(voidPromise());
            }
        }
    }, connectTimeoutMillis, TimeUnit.MILLISECONDS);
}
```

- 检查配置中的连接超时时间，如果大于 0，则在事件循环中调度一个超时任务。
- 超时任务将在指定时间后执行，检查 `connectPromise` 是否仍未完成。如果超时，将其标记为失败并关闭通道。

##### 监听连接取消事件

```java
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
```

- `promise` 添加一个 `ChannelFutureListener`，监听连接是否被取消。
- 如果 `promise` 被取消，取消超时任务（`connectTimeoutFuture.cancel(false)`），将 `connectPromise` 置为 `null` 并关闭通道。

![image-20241101114913993](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411011149040.png)

![image-20241101114917487](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411011149437.png)

在 `SocketUtils` 的 `connect` 方法中可以看到，底层通过 NIO 的 `SocketChannel` 实现连接。由于连接不会立即成功，所以通常不会返回 `true`。因此，`connected` 为 `false` 时，会执行下一行代码，注册 NIO 的 **连接事件**：

```Java
selectionKey().interestOps(SelectionKey.OP_CONNECT);
```

因为已经配置了连接事件，当底层连接建立完成后，接下来的逻辑处理会在哪里呢？还记得 `NioEventLoop` 中的 `run` 方法吗？

当发起连接后，会通过 `processSelectedKeys` 方法来处理连接建立成功事件。最终会执行到一段我们之前见过的代码：

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301721819.png)

::: warning

如果不清楚 `OP_CONNECT` 事件是在 TCP 三次握手中的哪个阶段产生的，请参阅[《Socket 网络编程》](/netty_source_code_parsing/main_task/network_communication_layer/socket_network_programming)。

:::

当 Reactor 中的 `Selector` 捕获到 `OP_CONNECT` 就绪事件时，会取消连接事件的注册。随后调用 `unsafe.finishConnect()` 来完成连接后的处理。在 `finishConnect` 方法中，又调用了 `fulfillConnectPromise(connectPromise, wasActive)` 方法来处理连接成功的后续逻辑。


![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301721446.png)

![image-20241101115448808](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411011154158.png)

随后，`pipeline().fireChannelActive()` 将从流水线的头部触发 `channelActive` 方法的回调。

![image-20241101115445038](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411011154077.png)

`HeadContext`首先会使流水线上的 `channelActive` 回调继续执行下去（在 Echo Server 的示例中，`EchoClientHandler` 的 `channelActive` 方法也会被调用）。当所有 `channelActive` 回调执行完毕后，调用 `readIfIsAutoRead` 方法，从流水线尾部开始逐个触发 `read` 方法（省略了部分步骤，大家可以自行查看代码）。最终，`read` 回调会再次到达头结点。

```java
@Override
public void read(ChannelHandlerContext ctx) {
    unsafe.beginRead();
}

@Override
public final void beginRead() {
    assertEventLoop();

    if (!isActive()) {
        return;
    }

    try {
        doBeginRead();
    } catch (final Exception e) {
        invokeLater(new Runnable() {
            @Override
            public void run() {
                pipeline.fireExceptionCaught(e);
            }
        });
        close(voidPromise());
    }
}


@Override
protected void doBeginRead() throws Exception {
    // Channel.read() or ChannelHandlerContext.read() was called
    if (inputShutdown) {
        return;
    }

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

在`HeadContext`中，调用了 `unsafe.beginRead()`，随后又调用了 `doBeginRead()`。在 `doBeginRead()` 方法中，可以看到注册了感兴趣的事件 `readInterestOp`。而 `readInterestOp` 所代表的事件正是创建 `channel` 时指定的 `OP_READ` 事件。

![image-20241101120111103](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411011201137.png)

## 总结

感觉没啥好说的。。