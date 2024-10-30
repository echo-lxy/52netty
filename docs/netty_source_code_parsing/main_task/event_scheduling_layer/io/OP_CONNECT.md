# 处理 OP_CONNECT 事件

## 前言

在 [Socket 编程基础](https://www.yuque.com/onejava/gwzrgm/nxcgfreilzqy1ycw) 中讲述了客户端和服务端Socket编程的状态流程图

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301658323.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301658821.png)

我们可知建立连接（connect），也就是 OP_CONNECT 事件是客户端这边的概念，也就是连接发起方的概念，当客户端 OP_CONNECT 事件产生，就说明第二次握手成功了，但是在Netty中不会阻塞等待第二次握手成功，而是在客户端发起 connnect 后往 文件套接字中注册OP_CONNECT 事件，然后Reactor线程就去干其他的事儿了，等待下次捕获到OP_CONNECT 事件时，再来完成注册Channel等一系列逻辑。

客户端的connect对标服务端的accept，我们在[Netty 如何建立网络连接](https://www.yuque.com/onejava/gwzrgm/udg76b6z7ir6ld45)会讲到，服务器中的 bind listen操作都是在内核完成的，用户只需要调用Socket的accept就可以等待客户端的一个连接，但是我们的 Main Reactor 也是往文件描述符中注册了此OP_ACCEPT事件，并且以IO多路的方式来实现连接接收，接收成功后，服务端会生成一个NioSocketChannel来负责此通信，并将此Channel注册到Sub Reactor。

本文旨在说明 Netty 客户端如何去和Netty服务器建立连接，我们以Netty源码包中的EchoClient为模板进行讲述

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301708700.png)

其实上述代码中那些 BootStrap 初始化逻辑我们在 [BootStrap 初始化](/netty_source_code_parsing/main_task/boot_layer/bootstrap_init) 一文中已经说过了

本文专注于剖析红框中的代码

## 建立连接过程

```java
ChannelFuture f = b.connect(HOST, PORT).sync();
```

我们来看看上述这行代码，它的语义是：阻塞直到连接建立成功，即 TCP 三次握手完成

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301708330.png)

`initAndRegister`会返回一个ChannelFuture对象，注册逻辑会提交给对应EventLoop来异步的执行，而通过这个ChannelFuture实例我们就可以判断异步任务的执行状态。由于是异步任务，所以它是否已经执行完毕不得知，所以通过ChannelFuture判断任务（注册任务）是否执行完毕，如果没有执行完毕就为其添加一个监听回调，回调时机发生在任务结束。当任务完成后，开始执行doConnect0方法。并返回一个新的ChannelFuture实例，顺便提一下通过这里的regFuture和promise，我们也可以看出netty中存在大量的异步处理方式。

### initAndRegister

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301709291.png)

上述方法的主要逻辑如下：

1. 创建并初始化 NioSocketChannel
2. 将创建好的 NioSocketChannel 注册到 Sub Reactor Group

创建一个 Channel 对象，这里可以先不用管，在[Netty 如何接收网络连接](https://www.yuque.com/onejava/gwzrgm/tgcgqew4b8nlpxes) 中会详细说明

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

上述代码也可以很清晰的看见Netty中高性能的影子，`regFuture.isDone()`会立刻判断 Channel是否初始化并注册完成，如果完成则直接执行`doResolveAndConnect0`，如果还未完成，就将`doResolveAndConnect0`放入regFuture的监听器中，不阻塞一丁点IO，将 CPU 的性能发挥到极致

【TODO】笔者觉得这里好像也没有什么性能提升，因为在`ChannelFuture f = b.connect(HOST, PORT).sync();`这里还是会阻塞

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

- 检查解析器是否支持解析 `remoteAddress`，或地址是否已解析。
- 如果地址已解析或解析器不支持此地址，则直接调用 `doConnect` 方法，跳过解析步骤，进行连接。

这里可以理解为如果是地址是域名，将其解析为IP地址，如果是IP地址，就不用解析了，直接doConnect

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

这里会进行一个简单的判断，判断是否指定了本机地址。我们也可以发现这里的 异步任务没有返回 promise或者Future了，因为这里的当前任务不再是普通的异步任务，而是需要由IO_CONNECT 事件去触发后续流程，所以触发点不再需要promise或者Future，而是IO事件驱动。

通过代码，我们看到，通道的连接操作又是作为一个异步任务交于channel所注册的EventLoop来执行，前提条件是注册任务必须已经成功完成了。在客户端，一般没有执行localAddress，所以我们继续跟踪channel.connect(remoteAddress, promise)，发现，channel的connect操作由pipeline来实现，这次与之前不同的是，它调用了connect操作，完成出站处理器在流水线上的执行，与入站从头开始不同，出站操作connect是从尾部开始的。与入站相似，会依次找到下一个出站处理器，回调其中的connect方法（这里大家可以调试看一下，不在赘述），最终pipeline的流程会到达**头结点**。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301718290.png)

头结点负责完成客户端连接的代码

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301718299.png)

在头结点中，调用了一个unsafe实例的connect方法。重点关注doConnect方法。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301718845.png)

##### 尝试连接

- 调用 `isActive()` 检查通道的当前活动状态。
- 尝试立即连接，`doConnect(remoteAddress, localAddress)` 返回 `true` 表示连接成功，直接调用 `fulfillConnectPromise(promise, wasActive)`，完成连接并更新状态。
- 如果连接未完成（返回 `false`），说明处于非阻塞模式，将 `promise` 和 `remoteAddress` 记录为待处理连接的 `connectPromise` 和 `requestedRemoteAddress`。

###### NioSocketChannel.doConnect 

在尝试连接阶段会执行此方法

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301719197.png)

可见此处的connnect方法属于“立即返回”

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730043032938-e9437c6f-1e57-4ea5-bc8d-82b09a07524b.png)

当其返回false，就说明当前未连接成功

然后会注册OP_CONNECT事件，等待被触发（希望你还记得我刚才说的触发点）

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730043269974-169e6bcc-93e4-4dbb-9d00-942b18f20bde.png)

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

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730039146381-08b5d9a6-f944-4306-bf75-72d46760ce74.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730039173112-23efe21c-f39c-4806-98a4-1d7f371dca44.png)

通过SocketUtils的connect方法，我们可以看到，底层借助NIO的SocketChannel进行连接。而由于连接不会立即成功，所以一般不会返回true，因此connected为false，则会执行下面这行代码，注册NIO**连接事件**。

```java
selectionKey().interestOps(SelectionKey.OP_CONNECT);
```

由于配置了连接事件，所以当底层连接建立好之后，后续的逻辑处理在哪里呢？还记得NioEventLoop里面的run方法吧。

当连接建立好后，会通过`processSelectedKeys`方法处理连接事件。最终会执行到这样一段在之前见到过的代码。

代码在这里再贴一下。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301721819.png)

当Reactor 中的Selector 捕获到 OP_CONNECT 就绪事件时会取消掉连接事件的注册。随后调用了unsafe.finishConnect()完成连接后的处理，finishConnect中调用了fulfillConnectPromise(connectPromise, wasActive)方法。


![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301721446.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730039412780-bc20c55f-fe56-462a-9173-33f796f81992.png)

随后，pipeline().fireChannelActive()就开始从流水线头部回调channelActive方法。

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730039468971-e699809d-51ef-4c62-b857-77d448f8ebec.png)

头部节点会首先让流水线上的channelActive回调继续下去（在Echo Server这个例子中，EchoClientHandler的channelActive方法也会执行），当所有的channelActive回调完成后，调用readIfIsAutoRead方法从流水线尾部开始逐个回调read方法（这里省略了一些步骤，大家可以自行查看）。最终read回调又会到达头结点。

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

在头部节点调用了unsafe.beginRead()，随后又调用doBeginRead，可以发现，在doBeginRead中，注册了readInterestOp事件。而readInterestOp所代表的的事件就是在生成channel时传入的读事件。因此在这里是完成了**读事件的注册**。

## 总结

感觉没啥好说的。。