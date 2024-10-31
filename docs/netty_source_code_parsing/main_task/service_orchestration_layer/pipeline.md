# 分拣流水线：Pipeline

## Pipeline 简介

### 依赖关系简介

Netty 中的 Pipeline  其实就是 ChannelPipeline 接口

我们来看看其类依赖关系

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410302103381.png" alt="image-20241030210307314" style="zoom:50%;" />



* ChannelInboundInvoker ChannelOutboundInvoker： `ChannelPipeline` 是一个链式处理器，用于在 Channel 中处理不同的入站和出站事件。通过继承 `ChannelInboundInvoker` 和 `ChannelOutboundInvoker` 接口，`ChannelPipeline` 能够直接调用这些接口中的方法，比如 `fireChannelRead()`、`write()` 等。这种设计统一了操作 Channel 的入口，使得 `ChannelPipeline` 既可以处理入站事件，也可以处理出站事件。
* `Iterable<ChannelHandler>`：`ChannelPipeline` 继承 `Iterable<ChannelHandler>` 的主要目的是为了简化遍历，使开发者可以方便地遍历整个 `ChannelPipeline` 中的所有 `ChannelHandler`，便于监控、调试或对每个 `ChannelHandler` 进行操作或分析。
* DefaultChannelPipeline：唯一的实现类

### ChannelPipeline 源码注释

**ChannelPipeline 的类注释中的核心点如下**

* **基本概念**
  * **ChannelPipeline** 是一个 `ChannelHandler` 列表，用于处理和拦截入站事件和出站操作。它实现了 **拦截过滤器模式**，允许用户完全控制事件处理流程及 `ChannelHandler` 之间的交互。
* **创建**
  * 每个 `Channel` 自动创建一个 `ChannelPipeline`，并在新通道生成时初始化。
*  **事件流动**
  * **入站事件**：通过 `ChannelInboundHandler` 自底向上处理，通常由 I/O 线程读取。
  * **出站事件**：通过 `ChannelOutboundHandler` 自顶向下处理，通常涉及写请求操作。
* **事件传播**
  * 使用 `ChannelHandlerContext` 中定义的方法（如 `fireChannelRead()` 和 `write()`）来将事件传递给下一个处理器。事件只在相关的处理器中处理，未处理的事件可能会被丢弃或记录。
* **管道构建**
  * `ChannelPipeline` 应包含多个 `ChannelHandler`，如：
    - **协议解码器**：将二进制数据转化为 Java 对象。
    - **协议编码器**：将 Java 对象转化为二进制数据。
    - **业务逻辑处理器**：执行具体的业务逻辑（如数据库访问）。
* **线程安全**
  * `ChannelPipeline` 是线程安全的，允许在运行时动态添加或移除 `ChannelHandler`，例如在敏感信息交换前后插入和移除加密处理器。



`ChannelPipeline` 管理的 `ChannelHandler` 集合处理`I/O`事件的流程图如下:

```ruby
                                                                                                 |
    +---------------------------------------------------+---------------+
    |                           ChannelPipeline         |               |
    |                                                  \|/              |
    |    +---------------------+            +-----------+----------+    |
    |    | Inbound Handler  N  |            | Outbound Handler  1  |    |
    |    +----------+----------+            +-----------+----------+    |
    |              /|\                                  |               |
    |               |                                  \|/              |
    |    +----------+----------+            +-----------+----------+    |
    |    | Inbound Handler N-1 |            | Outbound Handler  2  |    |
    |    +----------+----------+            +-----------+----------+    |
    |              /|\                                  .               |
    |               .                                   .               |
    | ChannelHandlerContext.fireIN_EVT() ChannelHandlerContext.OUT_EVT()|
    |        [ method call]                       [method call]         |
    |               .                                   .               |
    |               .                                  \|/              |
    |    +----------+----------+            +-----------+----------+    |
    |    | Inbound Handler  2  |            | Outbound Handler M-1 |    |
    |    +----------+----------+            +-----------+----------+    |
    |              /|\                                  |               |
    |               |                                  \|/              |
    |    +----------+----------+            +-----------+----------+    |
    |    | Inbound Handler  1  |            | Outbound Handler  M  |    |
    |    +----------+----------+            +-----------+----------+    |
    |              /|\                                  |               |
    +---------------+-----------------------------------+---------------+
                    |                                  \|/
    +---------------+-----------------------------------+---------------+
    |               |                                   |               |
    |       [ Socket.read() ]                    [ Socket.write() ]     |
    |                                                                   |
    |  Netty Internal I/O Threads (Transport Implementation)            |
    +-------------------------------------------------------------------+
```

可以看出 `ChannelPipeline`将管理的 `ChannelHandler` 分为两种:

- ```
  ChannelInboundHandler
  ```

   处理入站事件

  > - 入站事件是被动接收事件，例如接收远端数据，通道注册成功，通道变的活跃等等。
  > - 入站事件流向是从 `ChannelPipeline` 管理的 `ChannelInboundHandler` 列表头到尾。因为入站事件一般都是从远端发送过来，所以流向是从头到尾。
  > - 采用拦截器的模式，由`ChannelInboundHandler` 决定是否处理列表中的下一个 `ChannelInboundHandler`。

- ```
  ChannelOutboundHandler
  ```

   处理出站事件

  > - 出站事件是主动触发事件，例如绑定，注册，连接，断开，写入等等。
  > - 出站事件流向是从 `ChannelPipeline` 管理的 `ChannelOutboundHandler` 列表尾到头。因为出站事件最后要发送到远端，所以从尾到头。
  > - 采用拦截器的模式，由`ChannelInboundHandler` 决定是否处理列表中的下一个 `ChannelInboundHandler` (因为是从尾到头，这里的下一个，在列表中其实是上一个)。

## 源码

```Java
public interface ChannelPipeline
        extends ChannelInboundInvoker, ChannelOutboundInvoker, Iterable<Entry<String, ChannelHandler>> {

    // 在这个管道ChannelPipeline的开头插入给定的ChannelHandler。
    ChannelPipeline addFirst(String name, ChannelHandler handler);
    ChannelPipeline addFirst(EventExecutorGroup group, String name, ChannelHandler handler);

    // 在管道的最后追加给定的 ChannelHandler。
    ChannelPipeline addLast(String name, ChannelHandler handler);
    ChannelPipeline addLast(EventExecutorGroup group, String name, ChannelHandler handler);

    // 在此管道的现有ChannelHandler(名称是baseName)之前插入ChannelHandler。
    ChannelPipeline addBefore(String baseName, String name, ChannelHandler handler);

    // 在此管道的现有ChannelHandler(名称是baseName)之后插入ChannelHandler。
    ChannelPipeline addAfter(String baseName, String name, ChannelHandler handler);

    // 在这个管道ChannelPipeline的开头插入多个 ChannelHandler。
    ChannelPipeline addFirst(ChannelHandler... handlers);
    ChannelPipeline addLast(ChannelHandler... handlers);

    // 从管道中删除指定的 ChannelHandler
    ChannelPipeline remove(ChannelHandler handler);
    ChannelHandler remove(String name);
    <T extends ChannelHandler> T remove(Class<T> handlerType);
    ChannelHandler removeFirst();
    ChannelHandler removeLast();

    // 用新的 newHandler 替换该管道中指定老的 oldHandler。
    ChannelPipeline replace(ChannelHandler oldHandler, String newName, ChannelHandler newHandler);
    ChannelHandler replace(String oldName, String newName, ChannelHandler newHandler);
    <T extends ChannelHandler> T replace(Class<T> oldHandlerType, String newName, ChannelHandler newHandler);

    // 返回此管道中的第一个 ChannelHandler。
    ChannelHandler first();
    // 返回此管道中的最后一个 ChannelHandler。
    ChannelHandler last();

    // 返回此管道中指定名称的 ChannelHandler。
    ChannelHandler get(String name);
    <T extends ChannelHandler> T get(Class<T> handlerType);

    // 返回此管道中指定ChannelHandler的上下文对象ChannelHandlerContext。
    ChannelHandlerContext context(ChannelHandler handler);
    ChannelHandlerContext context(String name);
    ChannelHandlerContext context(Class<? extends ChannelHandler> handlerType);

    // 返回此管道依附的通道 Channel。
    Channel channel();

    // 返回此管道拥有的 ChannelHandler 名称的列表。
    List<String> names();
    // 返回此管道拥有的 ChannelHandler 集合
    Map<String, ChannelHandler> toMap();

    // -------   复写来自 ChannelInboundInvoker 中的方法  ---------//
    @Override
    ChannelPipeline fireChannelRegistered();
    @Override
    ChannelPipeline fireChannelActive();
    @Override
    ChannelPipeline fireExceptionCaught(Throwable cause);
    @Override
    ChannelPipeline fireChannelRead(Object msg);
    @Override
    ChannelPipeline flush();
}
```

不要看 `ChannelPipeline` 方法很多，其实主要分为两类:

1. 一类是管理 `ChannelHandler` 相关方法，比如向管道`ChannelPipeline`添加，删除，替换，查找 `ChannelHandler`  方法。
2. 一类是继承自 `ChannelInboundInvoker` 和 `ChannelOutboundInvoker` 方法，用于发送入站和出站事件。

> 这两个接口与入站事件处理接口`ChannelInboundHandler`和出站事件处理接口`ChannelOutboundHandler` 息息相关。
>
> - `ChannelInboundInvoker` 是用来发送入站事件的；
> - `ChannelOutboundInvoker` 是用来发送出站事件的。

在 `ChannelPipeline` 实现中:

1. `ChannelInboundInvoker` 发送的入站事件，会直接通过管道管理的 `ChannelInboundHandler` 列表从头到尾的触发，采用拦截器模式，由 `ChannelInboundHandler` 决定是否继续调用下一个 `ChannelInboundHandler` 处理。
2. `ChannelOutboundInvoker` 发送的出站事件，会直接通过管道管理的 `ChannelOutboundHandler` 列表从尾到头的触发，采用拦截器模式，由 `ChannelOutboundHandler` 决定是否继续调用下一个 `ChannelOutboundHandler` 处理。

### 管理 `ChannelHandler`

通过 AbstractChannelHandlerContext 的分析，我们知道其实管道ChannelPipeline 是通过双向链表来存储任务处理器的上下文列表的。

#### 双向链表

```java
final AbstractChannelHandlerContext head;
final AbstractChannelHandlerContext tail;

protected DefaultChannelPipeline(Channel channel) {
    this.channel = ObjectUtil.checkNotNull(channel, "channel");
    succeededFuture = new SucceededChannelFuture(channel, null);
    voidPromise =  new VoidChannelPromise(channel, true);

    tail = new TailContext(this);
    head = new HeadContext(this);

    head.next = tail;
    tail.prev = head;
}
```

`DefaultChannelPipeline` 使用成员属性 `head` 表示双向链表头，`tail` 表示双向链表尾，它们在管道创建的时候，也被创建并赋值了。通过它们，就可以从头或者从尾遍历整个链表中的节点了。

头尾节点在 ChannelHandlerContext【TODO】中有讲解

#### 添加

> 添加到管道 `ChannelPipeline`的`ChannelHandler`都要有一个名字，可以根据这个名字在管道中查找到这个`ChannelHandler`。

```Java
ChannelPipeline addFirst(String name, ChannelHandler handler);
ChannelPipeline addFirst(EventExecutorGroup group, String name, ChannelHandler handler);

ChannelPipeline addLast(String name, ChannelHandler handler);
ChannelPipeline addLast(EventExecutorGroup group, String name, ChannelHandler handler);

ChannelPipeline addBefore(String baseName, String name, ChannelHandler handler);
ChannelPipeline addBefore(EventExecutorGroup group, String baseName, String name, ChannelHandler handler);

ChannelPipeline addAfter(String baseName, String name, ChannelHandler handler);
ChannelPipeline addAfter(EventExecutorGroup group, String baseName, String name, ChannelHandler handler);

ChannelPipeline addFirst(ChannelHandler... handlers);
ChannelPipeline addFirst(EventExecutorGroup group, ChannelHandler... handlers);

ChannelPipeline addLast(ChannelHandler... handlers);
ChannelPipeline addLast(EventExecutorGroup group, ChannelHandler... handlers);
```

> - 可以向管道 `ChannelPipeline` 头或者尾插入一个或者多个`ChannelHandler`。
> - 可以在管道`ChannelPipeline`中已存在的某个`ChannelHandler`(通过`baseName` 查找到) ，之前或者之后插入一个`ChannelHandler`。

你会发现每个添加方法都有多一个 `EventExecutorGroup` 参数的对应方法，它作用是什么呢?

> - 我们知道通道 `Channel` 是注册到一个事件轮询器 `EventLoop` 中，通道所有的`IO` 事件都是通过在这个事件轮询器中获取。
> - 那么默认情况下，通道 `Channel` 对应的管道 `ChannelPipeline` 所管理的 `ChannelHandler` 也都是在这个事件轮询器中处理的。
> - 这就要求 `ChannelHandler`不能有太耗时操作，尤其是不能有阻塞操作，这样会导致整个事件轮询器被阻塞，会影响注册到这个事件轮询器所有通道的`IO` 事件处理，以及这个事件轮询器包含的所有待执行任务和计划任务。
> - 但是我们真的有这个方面的需求怎么办呢? 因此 `ChannelPipeline` 提供了多一个 `EventExecutorGroup` 参数的方法，它会将添加的这个 `ChannelHandler` 的所有方法都放在指定的这个事件执行器组`EventExecutorGroup`中执行，这样就不会阻塞通道 `Channel` 对应的事件轮询器。

#### 删除

#### 替换

```Java
ChannelPipeline replace(ChannelHandler oldHandler, String newName, ChannelHandler newHandler);

ChannelHandler replace(String oldName, String newName, ChannelHandler newHandler);

<T extends ChannelHandler> T replace(Class<T> oldHandlerType, String newName,ChannelHandler newHandler);
```

> - 用新的 `newHandler` 替换该管道中指定老的 `oldHandler`。
> - 用新的 `newHandler` 替换该管道中指定名称`oldName`或者指定类型`oldHandlerType` 对应的老 `ChannelHandler`, 并返回它。

```java
@Override
public final ChannelPipeline replace(ChannelHandler oldHandler, String newName, ChannelHandler newHandler) {
    replace(getContextOrDie(oldHandler), newName, newHandler);
    return this;
}

@Override
public final ChannelHandler replace(String oldName, String newName, ChannelHandler newHandler) {
    return replace(getContextOrDie(oldName), newName, newHandler);
}

@Override
@SuppressWarnings("unchecked")
public final <T extends ChannelHandler> T replace(
    Class<T> oldHandlerType, String newName, ChannelHandler newHandler) {
    return (T) replace(getContextOrDie(oldHandlerType), newName, newHandler);
}

private ChannelHandler replace(
    final AbstractChannelHandlerContext ctx, String newName, ChannelHandler newHandler) {
    // head 和 tail 比较特殊，不是用户定义的，
    // 所以它也不能被替换，不应该出现在这里
    assert ctx != head && ctx != tail;

    final AbstractChannelHandlerContext newCtx;
    // 使用synchronized锁，防止并发问题
    synchronized (this) {
        // 检查新的事件处理器 newHandler 重复性
        checkMultiplicity(newHandler);
        if (newName == null) {
            newName = generateName(newHandler);
        } else {
            boolean sameName = ctx.name().equals(newName);
            if (!sameName) {
                // 如果新名字 newName 和老名字不同，
                // 要检查新名字的重复性
                checkDuplicateName(newName);
            }
        }

        // 创建新事件处理器 newHandler 对应的上下文
        newCtx = newContext(ctx.executor, newName, newHandler);

        // 在管道中，用新的上下文替换老的上下文
        replace0(ctx, newCtx);

        /**
             * 下面就是改变新老上下文的状态：
             * 要将新的上下文状态变成 ADD_COMPLETE
             * 要将老的上下文状态变成 REMOVE_COMPLETE
             *
             * 而且必须先将新的上下文变成 ADD_COMPLETE，
             * 因为改变老的上下文状态时，有可能会触发新处理器的 channelRead() 或 flush() 方法
             */

        // 如果 registered == false，则表示该通道还没有在eventLoop上注册。
        if (!registered) {
            callHandlerCallbackLater(newCtx, true);
            callHandlerCallbackLater(ctx, false);
            return ctx.handler();
        }
        EventExecutor executor = ctx.executor();
        if (!executor.inEventLoop()) {
            // 如果当前线程不是新创建上下文的执行器线程，
            // 要切换到执行器线程执行
            executor.execute(new Runnable() {
                @Override
                public void run() {

                    callHandlerAdded0(newCtx);
                    callHandlerRemoved0(ctx);
                }
            });
            return ctx.handler();
        }
    }

    callHandlerAdded0(newCtx);
    callHandlerRemoved0(ctx);
    return ctx.handler();
}
```

替换操作的方法流程比添加复杂一点:

> - 检查新事件处理器的重复性和新名称的重复性
> - 创建新事件处理器 `newHandler` 对应的上下文
> - 通过 `replace0(ctx, newCtx)` 方法，用新的上下文替换老的上下文。
> - 最后改变改变新老上下文的状态，而且必须先将新的上下文状态变成 `ADD_COMPLETE`， 然后再将老的上下文状态变成 `REMOVE_COMPLETE`。

#### 查找

```Java
ChannelHandler get(String name);
<T extends ChannelHandler> T get(Class<T> handlerType);

ChannelHandlerContext context(ChannelHandler handler);
ChannelHandlerContext context(String name);
ChannelHandlerContext context(Class<? extends ChannelHandler> handlerType);
```

> - 根据名字或者类型从管道中查找对应的 `ChannelHandler` 对象。
> - 根据 `ChannelHandler` 或者名字或者类型从管道中查找对应的 `ChannelHandlerContext` 对象。
> - 其实管道`ChannelPipeline` 存储的是`ChannelHandlerContext` 对象，它是由 `ChannelHandler` 对象创建的，可以通过`ChannelHandlerContext`直接获取`ChannelHandler` 。

```kotlin
@Override
public final ChannelHandlerContext context(ChannelHandler handler) {
    ObjectUtil.checkNotNull(handler, "handler");

    AbstractChannelHandlerContext ctx = head.next;
    // 从链表头开始遍历
    for (;;) {
        // 遍历完了，那就返回 null
        if (ctx == null) {
            return null;
        }
        // 找到了，就返回这个上下文
        if (ctx.handler() == handler) {
            return ctx;
        }
        // 下一个上下文对象
        ctx = ctx.next;
    }
}

@Override
public final ChannelHandlerContext context(Class<? extends ChannelHandler> handlerType) {
    ObjectUtil.checkNotNull(handlerType, "handlerType");

    AbstractChannelHandlerContext ctx = head.next;
    // 从链表头开始遍历
    for (;;) {
        // 遍历完了，那就返回 null
        if (ctx == null) {
            return null;
        }
        // 找到了，就返回这个上下文
        if (handlerType.isAssignableFrom(ctx.handler().getClass())) {
            return ctx;
        }
        // 下一个上下文对象
        ctx = ctx.next;
    }
}

@Override
public final ChannelHandlerContext context(String name) {
    return context0(ObjectUtil.checkNotNull(name, "name"));
}

private AbstractChannelHandlerContext context0(String name) {
    AbstractChannelHandlerContext context = head.next;
    // 是不是遍历到链表尾部了
    while (context != tail) {
        // 找到了就返回
        if (context.name().equals(name)) {
            return context;
        }
        // 链表中的下一个
        context = context.next;
    }
    return null;
}
```

> 都是从双向链表头开始遍历，找到了就返回这个上下文，如果遍历到最后都没有找到，就返回 `null`。

#### 其他

```Java
ChannelHandler first();
ChannelHandlerContext firstContext();

ChannelHandler last();
ChannelHandlerContext lastContext();

List<String> names();
Map<String, ChannelHandler> toMap();
```

> - 获取管道头或者尾的 `ChannelHandler` 以及 `ChannelHandlerContext` 对象。
> - 获取管道拥有的 `ChannelHandler` 名称的列表。
> - 获取此管道拥有的 `ChannelHandler` 集合。

### 拦截 `IO` 事件

【TODO】在IO事件以一文中会详细讲解



## 核心行为

### 构造方法

![image-20241031192538897](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311925136.png)



Netty 会为每一个 Channel 分配一个独立的 pipeline ，pipeline 伴随着 channel 的创建而创建。

前边介绍到 NioServerSocketChannel 是在 netty 服务端启动的过程中创建的。而 NioSocketChannel 的创建是在当 NioServerSocketChannel 上的 OP_ACCEPT 事件活跃时，由 main reactor 线程在 NioServerSocketChannel 中创建，并在 NioServerSocketChannel 的 pipeline 中对 OP_ACCEPT 事件进行编排时（图中的 ServerBootstrapAcceptor 中）初始化的。

无论是创建 NioServerSocketChannel  里的 pipeline 还是创建 NioSocketChannel 里的 pipeline , 最终都会委托给它们的父类 AbstractChannel 。

![image-20241030212520299](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410302125362.png)

```java
public abstract class AbstractChannel extends DefaultAttributeMap implements Channel {

    protected AbstractChannel(Channel parent) {
        this.parent = parent;
        //channel全局唯一ID machineId+processId+sequence+timestamp+random
        id = newId();
        //unsafe用于底层socket的相关操作
        unsafe = newUnsafe();
        //为channel分配独立的pipeline用于IO事件编排
        pipeline = newChannelPipeline();
    }

    protected DefaultChannelPipeline newChannelPipeline() {
        return new DefaultChannelPipeline(this);
    }

}
public class DefaultChannelPipeline implements ChannelPipeline {

      ....................

    //pipeline中的头结点
    final AbstractChannelHandlerContext head;
    //pipeline中的尾结点
    final AbstractChannelHandlerContext tail;

    //pipeline中持有对应channel的引用
    private final Channel channel;

       ....................

    protected DefaultChannelPipeline(Channel channel) {
        //pipeline中持有对应channel的引用
        this.channel = ObjectUtil.checkNotNull(channel, "channel");
        
        ............省略.......

        tail = new TailContext(this);
        head = new HeadContext(this);

        head.next = tail;
        tail.prev = head;
    }

       ....................
}
```

在前边的系列文章中笔者多次提到过，pipeline 的结构是由 ChannelHandlerContext 类型的节点构成的双向链表。其中头结点为 HeadContext ，尾结点为 TailContext 。其初始结构如下

![image-20241031192717093](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311927150.png)

### 通过 ChannelInitializer 向 pipeline 添加 channelHandler

在我们详细介绍了全部的 inbound 类事件和 outbound 类事件的掩码表示以及事件的触发和传播路径后，相信大家现在可以通过 ChannelInboundHandler 和 ChannelOutboundHandler 来根据具体的业务场景选择合适的 ChannelHandler 类型以及监听合适的事件来完成业务需求了。

本小节就该介绍一下自定义的 ChannelHandler 是如何添加到 pipeline 中的，netty 在这个过程中帮我们作了哪些工作?

```java
final EchoServerHandler serverHandler = new EchoServerHandler();

ServerBootstrap b = new ServerBootstrap();
b.group(bossGroup, workerGroup)
 .channel(NioServerSocketChannel.class)

 .............

 .childHandler(new ChannelInitializer<SocketChannel>() {
     @Override
     public void initChannel(SocketChannel ch) throws Exception {
         ChannelPipeline p = ch.pipeline();          
         p.addLast(serverHandler);

         ......可添加多个channelHandler......
     }
 });
```

以上是笔者简化的一个 netty 服务端配置 ServerBootstrap 启动类的一段示例代码。我们可以看到再向 channel 对应的 pipeline 中添加 ChannelHandler 是通过 ChannelPipeline#addLast 方法将指定 ChannelHandler 添加到 pipeline 的末尾处。

```java
public interface ChannelPipeline
        extends ChannelInboundInvoker, ChannelOutboundInvoker, Iterable<Entry<String, ChannelHandler>> {

    //向pipeline的末尾处批量添加多个channelHandler
    ChannelPipeline addLast(ChannelHandler... handlers);

    //指定channelHandler的executor，由指定的executor执行channelHandler中的回调方法
    ChannelPipeline addLast(EventExecutorGroup group, ChannelHandler... handlers);

     //为channelHandler指定名称
    ChannelPipeline addLast(String name, ChannelHandler handler);

    //为channelHandler指定executor和name
    ChannelPipeline addLast(EventExecutorGroup group, String name, ChannelHandler handler);
}
public class DefaultChannelPipeline implements ChannelPipeline {

    @Override
    public final ChannelPipeline addLast(ChannelHandler... handlers) {
        return addLast(null, handlers);
    }

    @Override
    public final ChannelPipeline addLast(EventExecutorGroup executor, ChannelHandler... handlers) {
        ObjectUtil.checkNotNull(handlers, "handlers");

        for (ChannelHandler h: handlers) {
            if (h == null) {
                break;
            }
            addLast(executor, null, h);
        }

        return this;
    }

    @Override
    public final ChannelPipeline addLast(String name, ChannelHandler handler) {
        return addLast(null, name, handler);
    }
}
```

最终 addLast 的这些重载方法都会调用到 `DefaultChannelPipeline#addLast(EventExecutorGroup, String, ChannelHandler)` 这个方法从而完成 ChannelHandler 的添加。

```java
@Override
public final ChannelPipeline addLast(EventExecutorGroup group, String name, ChannelHandler handler) {
    final AbstractChannelHandlerContext newCtx;
    synchronized (this) {
        //检查同一个channelHandler实例是否允许被重复添加
        checkMultiplicity(handler);

        //创建channelHandlerContext包裹channelHandler并封装执行传播事件相关的上下文信息
        newCtx = newContext(group, filterName(name, handler), handler);

        //将channelHandelrContext插入到pipeline中的末尾处。双向链表操作
        //此时channelHandler的状态还是ADD_PENDING，只有当channelHandler的handlerAdded方法被回调后，状态才会为ADD_COMPLETE
        addLast0(newCtx);

        //如果当前channel还没有向reactor注册，则将handlerAdded方法的回调添加进pipeline的任务队列中
        if (!registered) {
            //这里主要是用来处理ChannelInitializer的情况
            //设置channelHandler的状态为ADD_PENDING 即等待添加,当状态变为ADD_COMPLETE时 channelHandler中的handlerAdded会被回调
            newCtx.setAddPending();
            //向pipeline中添加PendingHandlerAddedTask任务，在任务中回调handlerAdded
            //当channel注册到reactor后，pipeline中的pendingHandlerCallbackHead任务链表会被挨个执行
            callHandlerCallbackLater(newCtx, true);
            return this;
        }

        //如果当前channel已经向reactor注册成功，那么就直接回调channelHandler中的handlerAddded方法
        EventExecutor executor = newCtx.executor();
        if (!executor.inEventLoop()) {
            //这里需要确保channelHandler中handlerAdded方法的回调是在channel指定的executor中
            callHandlerAddedInEventLoop(newCtx, executor);
            return this;
        }
    }
    //回调channelHandler中的handlerAddded方法
    callHandlerAdded0(newCtx);
    return this;
}
```

这个方法的逻辑还是比较复杂的，涉及到很多细节，为了清晰地为大家讲述，笔者这里还是采用总分总的结构，先描述该方法的总体逻辑，然后在针对核心细节要点展开细节分析。

因为向 pipeline 中添加 channelHandler 的操作可能会在多个线程中进行，所以为了确保添加操作的线程安全性，这里采用一个 synchronized 语句块将整个添加逻辑包裹起来。

1. 通过 checkMultiplicity 检查被添加的 ChannelHandler 是否是共享的（标注 @Sharable 注解），如果不是共享的那么则不会允许该 ChannelHandler 的**同一实例**被添加进多个 pipeline 中。如果是共享的，则允许该 ChannelHandler 的**同一个实例**被多次添加进多个 pipeline 中。

```java
private static void checkMultiplicity(ChannelHandler handler) {
    if (handler instanceof ChannelHandlerAdapter) {
        ChannelHandlerAdapter h = (ChannelHandlerAdapter) handler;
        //只有标注@Sharable注解的channelHandler，才被允许同一个实例被添加进多个pipeline中
        //注意：标注@Sharable之后，一个channelHandler的实例可以被添加到多个channel对应的pipeline中
        //可能被多线程执行，需要确保线程安全
        if (!h.isSharable() && h.added) {
            throw new ChannelPipelineException(
                    h.getClass().getName() +
                    " is not a @Sharable handler, so can't be added or removed multiple times.");
        }
        h.added = true;
    }
}
```

这里大家需要注意的是，如果一个 ChannelHandler 被标注了 @Sharable 注解,这就意味着它的一个实例可以被多次添加进多个 pipeline 中（每个 channel 对应一个 pipeline 实例），而这多个不同的 pipeline 可能会被不同的 reactor 线程执行，所以在使用共享 ChannelHandler 的时候需要确保其线程安全性。

比如下面的实例代码：

```java
@Sharable
public class EchoServerHandler extends ChannelInboundHandlerAdapter {
            .............需要确保线程安全.......
}
final EchoServerHandler serverHandler = new EchoServerHandler();

ServerBootstrap b = new ServerBootstrap();
        b.group(bossGroup, workerGroup)
           ..................
        .childHandler(new ChannelInitializer<SocketChannel>() {
             @Override
             public void initChannel(SocketChannel ch) throws Exception {
                 ChannelPipeline p = ch.pipeline();
                 p.addLast(serverHandler);
             }
         });
```

EchoServerHandler 为我们自定义的 ChannelHandler ，它被 @Sharable 注解标注，全局只有一个实例，被添加进多个 Channel 的 pipeline 中。从而会被多个 reactor 线程执行到。

![image-20241031193319618](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311933766.png)

1. 为 ChannelHandler 创建其 ChannelHandlerContext ，用于封装 ChannelHandler 的名称，状态信息，执行上下文信息，以及用于感知 ChannelHandler 在 pipeline 中的位置信息。newContext 方法涉及的细节较多，后面我们单独介绍。
2. 通过 addLast0 将新创建出来的 ChannelHandlerContext 插入到 pipeline 中末尾处。方法的逻辑很简单其实就是一个普通的双向链表插入操作。

```java
private void addLast0(AbstractChannelHandlerContext newCtx) {
    AbstractChannelHandlerContext prev = tail.prev;
    newCtx.prev = prev;
    newCtx.next = tail;
    prev.next = newCtx;
    tail.prev = newCtx;
}
```

**但是这里大家需要注意的点是：**虽然此时 ChannelHandlerContext 被物理的插入到了 pipeline 中，但是此时 channelHandler 的状态依然为 INIT 状态，从逻辑上来说并未算是真正的插入到 pipeline 中，需要等到 ChannelHandler 的 handlerAdded 方法被回调时，状态才变为 ADD_COMPLETE ，而只有 ADD_COMPLETE 状态的 ChannelHandler 才能响应 pipeline 中传播的事件。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311943799.png)



在上篇文章[《一文搞懂Netty发送数据全流程》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484532&idx=1&sn=c3a8b37a2eb09509d9914494ef108c68&chksm=ce77c233f9004b25a29f9fdfb179e41646092d09bc89df2147a9fab66df13231e46dd6a5c26d&scene=21#wechat_redirect)中的《3.1.5 触发nextChannelHandler的write方法回调》小节中我们也提过，在每次 write 事件或者 flush 事件传播的时候，都需要通过 invokeHandler 方法来判断 channelHandler 的状态是否为 ADD_COMPLETE  ，否则当前 channelHandler 则不能响应正在 pipeline 中传播的事件。**必须要等到对应的 handlerAdded 方法被回调才可以，因为 handlerAdded 方法中可能包含一些 ChannelHandler 初始化的重要逻辑。**

```java
private boolean invokeHandler() {
    // 这里是一个优化点，netty 用一个局部变量保存 handlerState
    // 目的是减少 volatile 变量 handlerState 的读取次数
    int handlerState = this.handlerState;
    return handlerState == ADD_COMPLETE || (!ordered && handlerState == ADD_PENDING);
}

void invokeWrite(Object msg, ChannelPromise promise) {
    if (invokeHandler()) {
        invokeWrite0(msg, promise);
    } else {
        // 当前channelHandler虽然添加到pipeline中，但是并没有调用handlerAdded
        // 所以不能调用当前channelHandler中的回调方法，只能继续向前传递write事件
        write(msg, promise);
    }
}

private void invokeFlush() {
    if (invokeHandler()) {
        invokeFlush0();
    } else {
        //如果该ChannelHandler虽然加入到pipeline中但handlerAdded方法并未被回调，则继续向前传递flush事件
        flush();
    }
}
```

事实上不仅仅是 write 事件和 flush 事件在传播的时候需要判断 ChannelHandler 的状态，所有的 inbound 类事件和 outbound 类事件在传播的时候都需要通过 invokeHandler 方法来判断当前 ChannelHandler 的状态是否为 ADD_COMPLETE ，需要确保在 ChannelHandler 响应事件之前，它的 handlerAdded 方法被回调。

1. 如果向 pipeline 中添加 ChannelHandler 的时候， channel 还没来得及注册到 reactor中，那么需要将当前 ChannelHandler 的状态先设置为 ADD_PENDING ，并将回调该 ChannelHandler 的 handlerAdded 方法封装成 PendingHandlerAddedTask 任务添加进 pipeline 中的任务列表中，等到 channel 向 reactor 注册之后，reactor 线程会挨个执行 pipeline 中任务列表中的任务。

这段逻辑主要用来处理 ChannelInitializer 的添加场景，因为目前只有 ChannelInitializer 这个特殊的 channelHandler 会在 channel 没有注册之前被添加进 pipeline 中

```java
if (!registered) {
    newCtx.setAddPending();
    callHandlerCallbackLater(newCtx, true);
    return this;
}
```

向 pipeline 的任务列表 pendingHandlerCallbackHead 中添加 PendingHandlerAddedTask 任务：

```java
public class DefaultChannelPipeline implements ChannelPipeline {

    // pipeline中的任务列表
    private PendingHandlerCallback pendingHandlerCallbackHead;

    // 向任务列表尾部添加PendingHandlerAddedTask
    private void callHandlerCallbackLater(AbstractChannelHandlerContext ctx, boolean added) {
        assert !registered;

        PendingHandlerCallback task = added ? new PendingHandlerAddedTask(ctx) : new PendingHandlerRemovedTask(ctx);
        PendingHandlerCallback pending = pendingHandlerCallbackHead;
        if (pending == null) {
            pendingHandlerCallbackHead = task;
        } else {
            // Find the tail of the linked-list.
            while (pending.next != null) {
                pending = pending.next;
            }
            pending.next = task;
        }
    }
}
```

PendingHandlerAddedTask 任务负责回调 ChannelHandler 中的 handlerAdded 方法。

```java
private final class PendingHandlerAddedTask extends PendingHandlerCallback {
    ...............

    @Override
    public void run() {
        callHandlerAdded0(ctx);
    }

   ...............
}
private void callHandlerAdded0(final AbstractChannelHandlerContext ctx) {
   try {
        ctx.callHandlerAdded();
    } catch (Throwable t) {
       ...............
    }
}
```

![image-20241031194322237](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311943047.png)

1. 除了 ChannelInitializer 这个特殊的 ChannelHandler 的添加是在 channel 向 reactor 注册之前外，剩下的这些用户自定义的 ChannelHandler 的添加，均是在 channel 向 reactor 注册之后被添加进 pipeline 的。这种场景下的处理就会变得比较简单，在 ChannelHandler 被插入到 pipeline 中之后，就会立即回调该 ChannelHandler 的 handlerAdded 方法。**但是需要确保 handlerAdded 方法的回调在 channel 指定的 executor 中进行。**

```java
EventExecutor executor = newCtx.executor();
if (!executor.inEventLoop()) {
    callHandlerAddedInEventLoop(newCtx, executor);
    return this;
}  

callHandlerAdded0(newCtx);
```

如果当前执行线程并不是 ChannelHandler 指定的 executor ( !executor.inEventLoop() ),那么就需要确保 handlerAdded 方法的回调在 channel 指定的 executor 中进行。

```java
private void callHandlerAddedInEventLoop(final AbstractChannelHandlerContext newCtx, EventExecutor executor) {
    newCtx.setAddPending();
    executor.execute(new Runnable() {
        @Override
        public void run() {
            callHandlerAdded0(newCtx);
        }
    });
}
```

**这里需要注意的是需要在回调 handlerAdded 方法之前将 ChannelHandler 的状态提前设置为 ADD_COMPLETE 。** 因为用户可能在 ChannelHandler 中的 handerAdded 回调中触发一些事件，而如果此时 ChannelHandler 的状态不是 ADD_COMPLETE 的话，就会停止对事件的响应，从而错过事件的处理。

这种属于一种用户极端的使用情况。

```java
final void callHandlerAdded() throws Exception {
    if (setAddComplete()) {
        handler().handlerAdded(this);
    }
}
```

### 删除 ChannelHandler

从上个小节的内容中我们可以看到向 pipeline 中添加 ChannelHandler 的逻辑还是比较复杂的，涉及到的细节比较多。

那么在了解了向 pipeline 中添加 ChannelHandler 的过程之后，从 pipeline 中删除 ChannelHandler 的逻辑就变得很好理解了。

```java
public interface ChannelPipeline
        extends ChannelInboundInvoker, ChannelOutboundInvoker, Iterable<Entry<String, ChannelHandler>> {

    //从pipeline中删除指定的channelHandler
    ChannelPipeline remove(ChannelHandler handler);
    //从pipeline中删除指定名称的channelHandler
    ChannelHandler remove(String name);
    //从pipeline中删除特定类型的channelHandler
    <T extends ChannelHandler> T remove(Class<T> handlerType);
}
```

netty 提供了以上三种方式从 pipeline 中删除指定 ChannelHandler ，下面我们以第一种方式为例来介绍 ChannelHandler 的删除过程。

```java
public class DefaultChannelPipeline implements ChannelPipeline {

    @Override
    public final ChannelPipeline remove(ChannelHandler handler) {
        remove(getContextOrDie(handler));
        return this;
    }

}
```

#### getContextOrDie

首先需要通过 getContextOrDie 方法在 pipeline 中查找到指定的 ChannelHandler 对应的 ChannelHandelrContext 。以便确认要删除的 ChannelHandler 确实是存在于 pipeline 中。

context 方法是通过遍历 pipeline 中的双向链表来查找要删除的 ChannelHandlerContext 。

```java
private AbstractChannelHandlerContext getContextOrDie(ChannelHandler handler) {
    AbstractChannelHandlerContext ctx = (AbstractChannelHandlerContext) context(handler);
    if (ctx == null) {
        throw new NoSuchElementException(handler.getClass().getName());
    } else {
        return ctx;
    }
}

@Override
public final ChannelHandlerContext context(ChannelHandler handler) {
    ObjectUtil.checkNotNull(handler, "handler");
    // 获取 pipeline 双向链表结构的头结点
    AbstractChannelHandlerContext ctx = head.next;
    for (;;) {

        if (ctx == null) {
            return null;
        }

        if (ctx.handler() == handler) {
            return ctx;
        }

        ctx = ctx.next;
    }
}
```

#### remove

remove 方法的整体代码结构和 addLast0 方法的代码结构一样，整体逻辑也是先从 pipeline 中的双向链表结构中将指定的 ChanneHandlerContext 删除，然后在处理被删除的 ChannelHandler 中 handlerRemoved 方法的回调。

```java
private AbstractChannelHandlerContext remove(final AbstractChannelHandlerContext ctx) {
    assert ctx != head && ctx != tail;

    synchronized (this) {
        //从pipeline的双向列表中删除指定channelHandler对应的context
        atomicRemoveFromHandlerList(ctx);

        if (!registered) {
            //如果此时channel还未向reactor注册，则通过向pipeline中添加PendingHandlerRemovedTask任务
            //在注册之后回调channelHandelr中的handlerRemoved方法
            callHandlerCallbackLater(ctx, false);
            return ctx;
        }

        //channelHandelr从pipeline中删除后，需要回调其handlerRemoved方法
        //需要确保handlerRemoved方法在channelHandelr指定的executor中进行
        EventExecutor executor = ctx.executor();
        if (!executor.inEventLoop()) {
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    callHandlerRemoved0(ctx);
                }
            });
            return ctx;
        }
    }
    callHandlerRemoved0(ctx);
    return ctx;
}
```

1. 从 pipeline 中删除指定 ChannelHandler 对应的 ChannelHandlerContext 。逻辑比较简单，就是普通双向链表的删除操作。

```java
private synchronized void atomicRemoveFromHandlerList(AbstractChannelHandlerContext ctx) {
    AbstractChannelHandlerContext prev = ctx.prev;
    AbstractChannelHandlerContext next = ctx.next;
    prev.next = next;
    next.prev = prev;
}
```

1. 如果此时 channel 并未向对应的 reactor 进行注册，则需要向 pipeline 的任务列表中添加 PendingHandlerRemovedTask 任务，再该任务中会执行 ChannelHandler 的 handlerRemoved 回调，当 channel 向 reactor 注册成功后，reactor 会执行 pipeline 中任务列表中的任务，从而回调被删除 ChannelHandler 的 handlerRemoved 方法。

![image-20241031194316555](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311943073.png)

```java
private final class PendingHandlerRemovedTask extends PendingHandlerCallback {

    PendingHandlerRemovedTask(AbstractChannelHandlerContext ctx) {
        super(ctx);
    }

    @Override
    public void run() {
        callHandlerRemoved0(ctx);
    }
}
```

在执行 ChannelHandler 中 handlerRemoved 回调的时候，需要对 ChannelHandler 的状态进行判断：只有当 handlerState 为 ADD_COMPLETE 的时候才能回调 handlerRemoved 方法。

这里表达的语义是只有当 ChannelHanler 的 handlerAdded 方法被回调之后，那么在 ChannelHanler 被从 pipeline 中删除的时候它的 handlerRemoved 方法才可以被回调。

在 ChannelHandler 的 handlerRemove 方法被回调之后，将 ChannelHandler 的状态设置为 REMOVE_COMPLETE 。

```java
private void callHandlerRemoved0(final AbstractChannelHandlerContext ctx) {

    try {
        // 在这里回调 handlerRemoved 方法
        ctx.callHandlerRemoved();
    } catch (Throwable t) {
        fireExceptionCaught(new ChannelPipelineException(
                ctx.handler().getClass().getName() + ".handlerRemoved() has thrown an exception.", t));
    }
}

final void callHandlerRemoved() throws Exception {
    try {
        if (handlerState == ADD_COMPLETE) {
            handler().handlerRemoved(this);
        }
    } finally {
        // Mark the handler as removed in any case.
        setRemoved();
    }
}

final void setRemoved() {
    handlerState = REMOVE_COMPLETE;
}
```

1. 如果 channel 已经在 reactor 中注册成功，那么当 channelHandler 从 pipeline 中删除之后，需要立即回调其 handlerRemoved 方法。但是需要确保 handlerRemoved 方法在 channelHandler 指定的 executor 中进行。

### ChanneHandlerContext 的创建

我们在文章开头有提到这样一句话

> 其实它唯一创建的地方，就是当一个 `ChannelHandler` 添加到管道`ChannelPipeline`时，由`ChannelPipeline`创建一个包裹 `ChannelHandler` 的上下文`ChannelHandlerContext`对象添加进去。

接下来我们看看 ChannelPipeline#addFirst(String n ame, ChannelHandler handler)

#### ChannelPipeline.addFirst

```Java
@Override
public final ChannelPipeline addFirst(String n ame, ChannelHandler handler) {
    return addFirst(null, name, handler);
}

@Override
public final ChannelPipeline addFirst(EventExecutorGroup group, String name, ChannelHandler handler) {
    final AbstractChannelHandlerContext newCtx;
    // 使用synchronized锁，防止并发问题
    synchronized (this) {
        // 检查这个 handler 有没有重复
        checkMultiplicity(handler);
        // 过滤name，如果当前管道中已经存在这个名字的 ChannelHandler，
        // 直接抛出异常
        name = filterName(name, handler);

        // 创建这个事件处理器ChannelHandler对应的上下文对象
        newCtx = newContext(group, name, handler);

        // 将这个上下文对象添加到管道中
        // 因为是用双向链表存储的，所以就是改变链表节点的 next 和 prev指向
        addFirst0(newCtx);

        // 如果 registered == false，则表示该通道还没有在eventLoop上注册。
        // 因此我们将上下文的状态设置成正在添加状态，
        // 并添加一个任务，该任务将在通道注册后就会调用 ChannelHandler.handlerAdded(...)。
        if (!registered) {
            newCtx.setAddPending();
            callHandlerCallbackLater(newCtx, true);
            return this;
        }

        EventExecutor executor = newCtx.executor();
        if (!executor.inEventLoop()) {
            // 如果当前线程不是新创建上下文的执行器线程，
            // 那么使用executor.execute 方法，保证在执行器线程调用 callHandlerAdded0 方法
            callHandlerAddedInEventLoop(newCtx, executor);
            return this;
        }
    }
    // 将新创建上下文状态变成已添加，且调用 ChannelHandler.handlerAdded(...)方法
    callHandlerAdded0(newCtx);
    return this;
}
```

方法流程分析：

1. 因为添加 `ChannelHandler` 会在任何线程调用，所以使用 `synchronized` 锁来防止并发修改问题。

2. 通过 `checkMultiplicity(handler)`  方法检查这个 `handler` 有没有重复。

3. 通过 `filterName(name, handler)` 方法判断这个名字在当前管道中是否重复。

4. 通过 `newContext(group, name, handler)` 创建这个事件处理器`ChannelHandler`对应的上下文对象。

5. 通过 `addFirst0(newCtx)` 方法将新建上下文对象添加到管道中。

6. 下面就是关于新建上下文状态和

   ```
   ChannelHandler.handlerAdded(...)
   ```

    方法调用问题的处理，分为几种情况:

   > - 当管道对应的通道还没有注册到 `eventLoop`, 那么`handlerAdded(...)` 现在还不能被调用；那就先将上下文状态变成 `ADD_PENDING`,并添加一个任务，保证当通道添加之后，再将状态变成 `ADD_COMPLETE` 且调用`handlerAdded(...)` 方法。
   > - 当前线程不是新创建上下文执行器线程，那么也是先将上下文状态变成 `ADD_PENDING`, 并在上下文执行器线程中调用 `callHandlerAdded0` 方法。
   > - 不是上面情况，直接调用`callHandlerAdded0` 方法，将状态变成 `ADD_COMPLETE` 且调用`handlerAdded(...)` 方法。

#### 检查重复

`checkMultiplicity(...)`

```java
 private static void checkMultiplicity(ChannelHandler handler) {
     if (handler instanceof ChannelHandlerAdapter) {
         // 如果是 ChannelHandlerAdapter 的子类
         ChannelHandlerAdapter h = (ChannelHandlerAdapter) handler;
         // 只有 ChannelHandler 是可共享的，才能多次添加，
         // 否则 handler 已被添加(h.added == true) 的情况下，直接抛出异常
         if (!h.isSharable() && h.added) {
             throw new ChannelPipelineException(
                     h.getClass().getName() +
                     " is not a @Sharable handler, so can't be added or removed multiple times.");
         }
         h.added = true;
     }
 }
```

> 检查 `ChannelHandler` 是否重复
> 只有被 `@Sharable` 注解的`ChannelHandler` 才可以多次添加到一个或多个管道 `ChannelPipeline`。

#### 生成Name

`filterName(...)`

```java
private String filterName(String name, ChannelHandler handler) {
    if (name == null) {
        // 如果没有指定name,则会为handler默认生成一个name，该方法可确保默认生成的name在pipeline中不会重复
        return generateName(handler);
    }

    // 如果指定了name，需要确保name在pipeline中是唯一的
    checkDuplicateName(name);
    return name;
}
```

如果用户再向 pipeline 添加 ChannelHandler 的时候，为其指定了具体的名称，那么这里需要确保用户指定的名称在 pipeline 中是唯一的。

```java
private void checkDuplicateName(String name) {
    if (context0(name) != null) {
        throw new IllegalArgumentException("Duplicate handler name: " + name);
    }
}

/**
 * 通过指定名称在pipeline中查找对应的channelHandler 没有返回null
 * */
private AbstractChannelHandlerContext context0(String name) {
    AbstractChannelHandlerContext context = head.next;
    while (context != tail) {
        if (context.name().equals(name)) {
            return context;
        }
        context = context.next;
    }
    return null;
}
```

如果用户没有为 ChannelHandler 指定名称，那么就需要为 ChannelHandler 在 pipeline 中默认生成一个唯一的名称。

```java
// pipeline中channelHandler对应的name缓存
private static final FastThreadLocal<Map<Class<?>, String>> nameCaches =
        new FastThreadLocal<Map<Class<?>, String>>() {
    @Override
    protected Map<Class<?>, String> initialValue() {
        return new WeakHashMap<Class<?>, String>();
    }
};

private String generateName(ChannelHandler handler) {
    // 获取pipeline中channelHandler对应的name缓存
    Map<Class<?>, String> cache = nameCaches.get();
    Class<?> handlerType = handler.getClass();
    String name = cache.get(handlerType);
    if (name == null) {
        // 当前handler还没对应的name缓存，则默认生成：simpleClassName + #0
        name = generateName0(handlerType);
        cache.put(handlerType, name);
    }

    if (context0(name) != null) {
        // 不断重试名称后缀#n + 1 直到没有重复
        String baseName = name.substring(0, name.length() - 1); 
        for (int i = 1;; i ++) {
            String newName = baseName + i;
            if (context0(newName) == null) {
                name = newName;
                break;
            }
        }
    }
    return name;
}

private static String generateName0(Class<?> handlerType) {
    return StringUtil.simpleClassName(handlerType) + "#0";
}
```

pipeline 中使用了一个 FastThreadLocal 类型的 nameCaches 来缓存各种类型 ChannelHandler 的基础名称。后面会根据这个基础名称不断的重试生成一个没有冲突的正式名称。缓存 nameCaches 中的 key 表示特定的 ChannelHandler 类型，value 表示该特定类型的 ChannelHandler 的基础名称  `simpleClassName + #0`。

自动为 ChannelHandler 生成默认名称的逻辑是：

- 首先从缓存中 nameCaches 获取当前添加的 ChannelHandler 的基础名称 `simpleClassName + #0`。
- 如果该基础名称 `simpleClassName + #0` 在 pipeline 中是唯一的，那么就将基础名称作为 ChannelHandler 的名称。
- 如果缓存的基础名称在 pipeline 中不是唯一的，则不断的增加名称后缀 `simpleClassName#1 ,simpleClassName#2 ...... simpleClassName#n` 直到产生一个没有重复的名称。

虽然用户不大可能将同一类型的 channelHandler 重复添加到 pipeline 中，但是 netty 为了防止这种反复添加同一类型 ChannelHandler 的行为导致的名称冲突，从而利用 nameCaches 来缓存同一类型 ChannelHandler 的基础名称 `simpleClassName + #0`，然后通过不断的重试递增名称后缀，来生成一个在pipeline中唯一的名称。

#### 构造 DefaultChannelHandlerContext

`newContext(...)`

```csharp
  private AbstractChannelHandlerContext newContext(EventExecutorGroup group, String name, ChannelHandler handler) {
     return new DefaultChannelHandlerContext(this, childExecutor(group), name, handler);
 }

  private EventExecutor childExecutor(EventExecutorGroup group) {
     if (group == null) {
         return null;
     }
     Boolean pinEventExecutor = channel.config().getOption(ChannelOption.SINGLE_EVENTEXECUTOR_PER_GROUP);
     if (pinEventExecutor != null && !pinEventExecutor) {
         return group.next();
     }
     Map<EventExecutorGroup, EventExecutor> childExecutors = this.childExecutors;
     if (childExecutors == null) {
         // 使用4的大小，因为大多数情况下只使用一个额外的 EventExecutor。
         childExecutors = this.childExecutors = new IdentityHashMap<EventExecutorGroup, EventExecutor>(4);
     }
     // 虽然一个事件处理器组 EventExecutorGroup 中管理有多个子事件处理器 EventExecutor，
     // 但是对于同一个通道 Channel 应该使用同一个子事件处理器 EventExecutor，
     // 以便使用相同的子执行器触发相同通道的事件。
     EventExecutor childExecutor = childExecutors.get(group);
     // 如果 childExecutor 不为null，直接返回 childExecutor，使用同个子事件处理器
     if (childExecutor == null) {
         // 没有，则从事件处理器组中获取一个子事件处理器。
         childExecutor = group.next();
         // 记录它，保证同一个管道是同一个子事件处理器。
         childExecutors.put(group, childExecutor);
     }
     return childExecutor;
 }
```

> - 直接创建事件处理器`ChannelHandler` 对应的上下文。
> - `childExecutor(group)` 保证同一个管道添加的子事件执行器 `EventExecutor` 是同一个。

通过前边的介绍我们了解到，当我们向 pipeline 添加 ChannelHandler 的时候，netty 允许我们为 ChannelHandler 指定特定的 executor 去执行 ChannelHandler 中的各种事件回调方法。

通常我们会为 ChannelHandler 指定一个EventExecutorGroup，在创建ChannelHandlerContext 的时候，会通过 childExecutor 方法从 EventExecutorGroup 中选取一个 EventExecutor 来与该 ChannelHandler 绑定。

EventExecutorGroup 是 netty 自定义的一个线程池模型，其中包含多个 EventExecutor ，而 EventExecutor 在 netty 中是一个线程的执行模型。相关的具体实现和用法笔者已经在[《Reactor在Netty中的实现(创建篇)》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247483907&idx=1&sn=084c470a8fe6234c2c9461b5f713ff30&chksm=ce77c444f9004d52e7c6244bee83479070effb0bc59236df071f4d62e91e25f01715fca53696&scene=21#wechat_redirect)一文中给出了详尽的介绍，忘记的同学可以在回顾下。

在介绍 executor 的绑定逻辑之前，这里笔者需要先为大家介绍一个相关的重要参数：`SINGLE_EVENTEXECUTOR_PER_GROUP` ，默认为 true 。

```java
ServerBootstrap b = new ServerBootstrap();
b.group(bossGroup, workerGroup)
.channel(NioServerSocketChannel.class)
  .........
.childOption(ChannelOption.SINGLE_EVENTEXECUTOR_PER_GROUP,true）
```

我们知道在 netty 中，每一个 channel 都会对应一个独立的 pipeline ，如果我们开启了 `SINGLE_EVENTEXECUTOR_PER_GROUP` 参数，表示在一个 channel 对应的 pipeline 中，如果我们为多个 ChannelHandler 指定了同一个 EventExecutorGroup ，那么这多个 channelHandler 只能绑定到 EventExecutorGroup 中的同一个 EventExecutor 上。

什么意思呢？？比如我们有下面一段初始化`pipeline`的代码：

```java
ServerBootstrap b = new ServerBootstrap();
b.group(bossGroup, workerGroup)
     ........................
 .childHandler(new ChannelInitializer<SocketChannel>() {
     @Override
     public void initChannel(SocketChannel ch) throws Exception {
         ChannelPipeline pipeline = ch.pipeline();
         pipeline.addLast(eventExecutorGroup,channelHandler1)
         pipeline.addLast(eventExecutorGroup,channelHandler2)
         pipeline.addLast(eventExecutorGroup,channelHandler3)
     }
 });
```

eventExecutorGroup 中包含 EventExecutor1，EventExecutor2 ， EventExecutor3 三个执行线程。

假设此时第一个连接进来，在创建 channel1 后初始化 pipeline1 的时候，如果在开启 `SINGLE_EVENTEXECUTOR_PER_GROUP` 参数的情况下，那么在 channel1 对应的 pipeline1 中 channelHandler1，channelHandler2 ， channelHandler3 绑定的 EventExecutor 均为 EventExecutorGroup 中的 EventExecutor1 。

第二个连接 channel2 对应的 pipeline2 中 channelHandler1 ， channelHandler2 ，channelHandler3 绑定的 EventExecutor 均为 EventExecutorGroup 中的 EventExecutor2 。

第三个连接 channel3 对应的 pipeline3 中 channelHandler1 ， channelHandler2 ，channelHandler3 绑定的 EventExecutor 均为 EventExecutorGroup 中的 EventExecutor3 。

以此类推........

![image-20241031194308770](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311943399.png)

如果在关闭 `SINGLE_EVENTEXECUTOR_PER_GROUP` 参数的情况下, channel1 对应的 pipeline1 中 channelHandler1 会绑定到 EventExecutorGroup 中的 EventExecutor1 ，channelHandler2 会绑定到 EventExecutor2 ，channelHandler3 会绑定到 EventExecutor3 。

同理其他 channel 对应的 pipeline 中的 channelHandler 绑定逻辑同 channel1 。它们均会绑定到 EventExecutorGroup 中的不同 EventExecutor 中。

![image-20241031194303482](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311943169.png)

当我们了解了 `SINGLE_EVENTEXECUTOR_PER_GROUP ` 参数的作用之后，再来看下面这段绑定逻辑就很容易理解了。

```java
// 在每个pipeline中都会保存EventExecutorGroup中绑定的线程
private Map<EventExecutorGroup, EventExecutor> childExecutors;

private EventExecutor childExecutor(EventExecutorGroup group) {
    if (group == null) {
        return null;
    }

    Boolean pinEventExecutor = channel.config().getOption(ChannelOption.SINGLE_EVENTEXECUTOR_PER_GROUP);
    if (pinEventExecutor != null && !pinEventExecutor) {
        //如果没有开启SINGLE_EVENTEXECUTOR_PER_GROUP，则按顺序从指定的EventExecutorGroup中为channelHandler分配EventExecutor
        return group.next();
    }

    //获取pipeline绑定到EventExecutorGroup的线程（在一个pipeline中会为每个指定的EventExecutorGroup绑定一个固定的线程）
    Map<EventExecutorGroup, EventExecutor> childExecutors = this.childExecutors;
    if (childExecutors == null) {
        childExecutors = this.childExecutors = new IdentityHashMap<EventExecutorGroup, EventExecutor>(4);
    }

    //获取该pipeline绑定在指定EventExecutorGroup中的线程
    EventExecutor childExecutor = childExecutors.get(group);
    if (childExecutor == null) {
        childExecutor = group.next();
        childExecutors.put(group, childExecutor);
    }
    return childExecutor;
}
```

如果我们并未特殊指定 ChannelHandler 的 executor ，那么默认会是对应 channel 绑定的 reactor 线程负责执行该 ChannelHandler 。

如果我们未开启 `SINGLE_EVENTEXECUTOR_PER_GROUP ` ，netty 就会从我们指定的 EventExecutorGroup 中按照 round-robin 的方式为 ChannelHandler 绑定其中一个 eventExecutor 。

![image-20241031194258633](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942958.png)

如果我们开启了 `SINGLE_EVENTEXECUTOR_PER_GROUP `，**相同的 EventExecutorGroup 在同一个 pipeline 实例中的绑定关系是固定的**。在 pipeline 中如果多个 channelHandler 指定了同一个 EventExecutorGroup ，那么这些 channelHandler 的 executor 均会绑定到一个固定的 eventExecutor 上。

![image-20241031194253838](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942951.png)



这种固定的绑定关系缓存于每个 pipeline 中的 Map<EventExecutorGroup, EventExecutor> childExecutors 字段中，key 是用户为 channelHandler 指定的 EventExecutorGroup ，value 为该 EventExecutorGroup 在 pipeline 实例中的绑定 eventExecutor 。

接下来就是从 childExecutors 中获取指定 EventExecutorGroup 在该 pipeline 实例中的绑定 eventExecutor，如果绑定关系还未建立，则通过 round-robin 的方式从 EventExecutorGroup 中选取一个 eventExecutor 进行绑定，并在 childExecutor 中缓存绑定关系。

如果绑定关系已经建立，则直接为 ChannelHandler 指定绑定好的 eventExecutor。

#### `addFirst0(...)`

```cpp
 private void addFirst0(AbstractChannelHandlerContext newCtx) {
     AbstractChannelHandlerContext nextCtx = head.next;
     newCtx.prev = head;
     newCtx.next = nextCtx;
     head.next = newCtx;
     nextCtx.prev = newCtx;
 }
```

> 因为是双向链表，所以插入一个节点，是要改变当前插入位置前节点的 `next` 和后节点的 `prev`,以及这个插入节点的`next` 和 `prev`。

### pipeline 的初始化

其实关于 pipeline 初始化的相关内容我们在[《详细图解 Netty Reactor 启动全流程》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484005&idx=1&sn=52f51269902a58f40d33208421109bc3&chksm=ce77c422f9004d340e5b385ef6ba24dfba1f802076ace80ad6390e934173a10401e64e13eaeb&scene=21#wechat_redirect)中已经简要介绍了 NioServerSocketChannel 中的 pipeline 的初始化时机以及过程。

在[《Netty 如何高效接收网络连接》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484184&idx=1&sn=726877ce28cf6e5d2ac3225fae687f19&chksm=ce77c55ff9004c493b592288819dc4d4664b5949ee97fed977b6558bc517dad0e1f73fab0f46&scene=21#wechat_redirect)中笔者也简要介绍了 NioSocketChannel 中 pipeline 的初始化时机以及过程。

本小节笔者将结合这两种类型的 Channel 来完整全面的介绍 pipeline 的整个初始化过程。

#### NioServerSocketChannel 中 pipeline 的初始化

从前边提到的这两篇文章以及本文前边的相关内容我们知道，Netty 提供了一个特殊的 ChannelInboundHandler 叫做 ChannelInitializer ，用户可以利用这个特殊的 ChannelHandler 对 Channel 中的 pipeline 进行自定义的初始化逻辑。

如果用户只希望在 pipeline 中添加一个固定的 ChannelHandler 可以通过如下代码直接添加。

```java
ServerBootstrap b = new ServerBootstrap();
    b.group(bossGroup, workerGroup)//配置主从Reactor
          ...........
     .handler(new LoggingHandler(LogLevel.INFO))
```

如果希望添加多个 ChannelHandler ，则可以通过 ChannelInitializer 来自定义添加逻辑。

由于使用 ChannelInitializer 初始化 NioServerSocketChannel 中 pipeline 的逻辑会稍微复杂一点，下面我们均以这个复杂的案例来讲述 pipeline 的初始化过程。

```java
ServerBootstrap b = new ServerBootstrap();
    b.group(bossGroup, workerGroup)//配置主从Reactor
          ...........
       .handler(new ChannelInitializer<NioServerSocketChannel>() {
         @Override
         protected void initChannel(NioServerSocketChannel ch) throws Exception {
              ....自定义pipeline初始化逻辑....
               ChannelPipeline p = ch.pipeline();
               p.addLast(channelHandler1);
               p.addLast(channelHandler2);
               p.addLast(channelHandler3);
                    ........
         }
     })
```

以上这些由用户自定义的用于初始化 pipeline 的 ChannelInitializer ，被保存至 ServerBootstrap 启动类中的 handler 字段中。用于后续的初始化调用

```java
public abstract class AbstractBootstrap<B extends AbstractBootstrap<B, C>, C extends Channel> implements Cloneable
   private volatile ChannelHandler handler;
}
```



在服务端启动的时候，会伴随着 NioServeSocketChannel 的创建以及初始化，在初始化 NioServerSokcetChannel 的时候会将一个新的 ChannelInitializer 添加进 pipeline 中，在新的 ChannelInitializer 中才会将用户自定义的 ChannelInitializer 添加进 pipeline 中，随后才执行初始化过程。

Netty 这里之所以引入一个新的 ChannelInitializer 来初始化 NioServerSocketChannel 中的 pipeline 的原因是需要兼容前边介绍的这两种初始化 pipeline 的方式。

- 一种是直接使用一个具体的 ChannelHandler 来初始化 pipeline。
- 另一种是使用 ChannelInitializer 来自定义初始化 pipeline 逻辑。

忘记 netty 启动过程的同学可以在回看下笔者的[《详细图解 Netty Reactor 启动全流程》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484005&idx=1&sn=52f51269902a58f40d33208421109bc3&chksm=ce77c422f9004d340e5b385ef6ba24dfba1f802076ace80ad6390e934173a10401e64e13eaeb&scene=21#wechat_redirect)这篇文章。

```java
@Override
void init(Channel channel) {
   .........

    p.addLast(new ChannelInitializer<Channel>() {
        @Override
        public void initChannel(final Channel ch) {
            final ChannelPipeline pipeline = ch.pipeline();
            //ServerBootstrap中用户指定的channelHandler
            ChannelHandler handler = config.handler();
            if (handler != null) {
                pipeline.addLast(handler);
            }

            .........
        }
    });
}
```

**注意此时 NioServerSocketChannel 并未开始向 Main Reactor 注册**，根据本文第四小节《4. 向 pipeline 添加 channelHandler 》中的介绍，此时向 pipeline 中添加这个新的 ChannelInitializer 之后，netty 会向 pipeline 的任务列表中添加 PendingHandlerAddedTask 。当 NioServerSocketChannel 向 Main Reactor 注册成功之后，紧接着 Main Reactor 线程会调用这个 PendingHandlerAddedTask ，在任务中会执行这个新的 ChannelInitializer 的 handlerAdded 回调。在这个回调方法中会执行上边 initChannel 方法里的代码。

![image-20241031194242762](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942100.png)

当 NioServerSocketChannel 在向 Main Reactor 注册成功之后，就挨个执行 pipeline 中的任务列表中的任务。

```java
private void register0(ChannelPromise promise) {
             .........
        boolean firstRegistration = neverRegistered;
        //执行真正的注册操作
        doRegister();
        //修改注册状态
        neverRegistered = false;
        registered = true;
        //调用pipeline中的任务链表，执行PendingHandlerAddedTask
        pipeline.invokeHandlerAddedIfNeeded();
        .........
final void invokeHandlerAddedIfNeeded() {
    assert channel.eventLoop().inEventLoop();
    if (firstRegistration) {
        firstRegistration = false;
        // 执行 pipeline 任务列表中的 PendingHandlerAddedTask 任务。
        callHandlerAddedForAllHandlers();
    }
}
```

执行 pipeline 任务列表中的 PendingHandlerAddedTask 任务：

```java
private void callHandlerAddedForAllHandlers() {
    // pipeline 任务列表中的头结点
    final PendingHandlerCallback pendingHandlerCallbackHead;
    synchronized (this) {
        assert !registered;
        // This Channel itself was registered.
        registered = true;
        pendingHandlerCallbackHead = this.pendingHandlerCallbackHead;
        // Null out so it can be GC'ed.
        this.pendingHandlerCallbackHead = null;
    }

    PendingHandlerCallback task = pendingHandlerCallbackHead;
    // 挨个执行任务列表中的任务
    while (task != null) {
        //触发 ChannelInitializer 的 handlerAdded 回调
        task.execute();
        task = task.next;
    }
}
```

最终在 PendingHandlerAddedTask 中执行 pipeline 中 ChannelInitializer 的 handlerAdded 回调。

这个 ChannelInitializer 就是在初始化 NioServerSocketChannel 的 init 方法中向 pipeline 添加的 ChannelInitializer。

```java
@Sharable
public abstract class ChannelInitializer<C extends Channel> extends ChannelInboundHandlerAdapter {

    @Override
    public void handlerAdded(ChannelHandlerContext ctx) throws Exception {
        if (ctx.channel().isRegistered()) {

            if (initChannel(ctx)) {
                //初始化工作完成后，需要将自身从pipeline中移除
                removeState(ctx);
            }
        }
    }

}
```

在 handelrAdded 回调中执行 ChannelInitializer 匿名类中 initChannel 方法，**注意此时执行的 ChannelInitializer 类为在本小节开头 init 方法中由 Netty 框架添加的 ChannelInitializer ，并不是用户自定义的 ChannelInitializer 。**

```java
@Override
void init(Channel channel) {
   .........

    p.addLast(new ChannelInitializer<Channel>() {
        @Override
        public void initChannel(final Channel ch) {
            final ChannelPipeline pipeline = ch.pipeline();
            //ServerBootstrap中用户指定的ChannelInitializer
            ChannelHandler handler = config.handler();
            if (handler != null) {
                pipeline.addLast(handler);
            }

            .........
        }
    });
}
```

执行完 ChannelInitializer 匿名类中 initChannel 方法后，需将 ChannelInitializer 从 pipeline 中删除。并回调 ChannelInitializer 的 handlerRemoved 方法。删除过程笔者已经在第六小节《6. 从 pipeline 删除 channelHandler》详细介绍过了。

```java
private boolean initChannel(ChannelHandlerContext ctx) throws Exception {
    if (initMap.add(ctx)) { // Guard against re-entrance.
        try {
            //执行ChannelInitializer匿名类中的initChannel方法
            initChannel((C) ctx.channel());
        } catch (Throwable cause) {
            exceptionCaught(ctx, cause);
        } finally {
            ChannelPipeline pipeline = ctx.pipeline();
            if (pipeline.context(this) != null) {
                //初始化完毕后，从pipeline中移除自身
                pipeline.remove(this);
            }
        }
        return true;
    }
    return false;
}
```

当执行完 initChannel 方法后此时 pipeline 的结构如下图所示：

![image-20241031194237445](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942628.png)

当用户的自定义 ChannelInitializer 被添加进 pipeline 之后，根据第四小节所讲的添加逻辑，此时 NioServerSocketChannel 已经向 main reactor 成功注册完毕，不再需要向 pipeine 的任务列表中添加 PendingHandlerAddedTask 任务，而是直接调用自定义 ChannelInitializer 中的 handlerAdded 回调，和上面的逻辑一样。不同的是这里最终回调至用户自定义的初始化逻辑实现 initChannel 方法中。执行完用户自定义的初始化逻辑之后，从 pipeline 删除用户自定义的 ChannelInitializer 。

```java
ServerBootstrap b = new ServerBootstrap();
    b.group(bossGroup, workerGroup)//配置主从Reactor
          ...........
       .handler(new ChannelInitializer<NioServerSocketChannel>() {
         @Override
         protected void initChannel(NioServerSocketChannel ch) throws Exception {
              ....自定义pipeline初始化逻辑....
               ChannelPipeline p = ch.pipeline();
               p.addLast(channelHandler1);
               p.addLast(channelHandler2);
               p.addLast(channelHandler3);
                    ........
         }
     })
```

随后 netty 会以异步任务的形式向 pipeline 的末尾添加 ServerBootstrapAcceptor ，至此 NioServerSocketChannel 中 pipeline 的初始化工作就全部完成了。

#### NioSocketChannel 中 pipeline 的初始化

在 7.1 小节中笔者举的这个 pipeline 初始化的例子相对来说比较复杂，当我们把这个复杂例子的初始化逻辑搞清楚之后，NioSocketChannel 中 pipeline 的初始化过程就变的很简单了。

```java
ServerBootstrap b = new ServerBootstrap();
    b.group(bossGroup, workerGroup)//配置主从Reactor
          ...........
       .childHandler(new ChannelInitializer<SocketChannel>() {
         @Override
         protected void initChannel(SocketChannel ch) throws Exception {
              ....自定义pipeline初始化逻辑....
               ChannelPipeline p = ch.pipeline();
               p.addLast(channelHandler1);
               p.addLast(channelHandler2);
               p.addLast(channelHandler3);
                    ........
         }
     })
public class ServerBootstrap extends AbstractBootstrap<ServerBootstrap, ServerChannel> {
    //保存用户自定义ChannelInitializer
    private volatile ChannelHandler childHandler;
}
```

在[《Netty 如何高效接收网络连接》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247484184&idx=1&sn=726877ce28cf6e5d2ac3225fae687f19&chksm=ce77c55ff9004c493b592288819dc4d4664b5949ee97fed977b6558bc517dad0e1f73fab0f46&scene=21#wechat_redirect)一文中我们介绍过，当客户端发起连接，完成三次握手之后，NioServerSocketChannel 上的 OP_ACCEPT 事件活跃，随后会在 NioServerSocketChannel 的 pipeline 中触发 channelRead 事件。并最终在 ServerBootstrapAcceptor 中初始化客户端 NioSocketChannel 。

![image-20241031194232275](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942447.png)

```java
private static class ServerBootstrapAcceptor extends ChannelInboundHandlerAdapter {

    @Override
    @SuppressWarnings("unchecked")
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        final Channel child = (Channel) msg;
        child.pipeline().addLast(childHandler);
                ...........
    }
}
```

在这里会将用户自定义的 ChannelInitializer 添加进 NioSocketChannel 中的 pipeline 中，由于此时 NioSocketChannel 还没有向 sub reactor 开始注册。所以在向 pipeline 中添加 ChannelInitializer 的同时会伴随着 PendingHandlerAddedTask 被添加进 pipeline 的任务列表中。

![image-20241031194226836](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942014.png)

后面的流程大家应该很熟悉了，和我们在7.1小节中介绍的一模一样，当 NioSocketChannel 再向 sub reactor 注册成功之后，会执行 pipeline 中的任务列表中的 PendingHandlerAddedTask 任务，在 PendingHandlerAddedTask 任务中会回调用户自定义 ChannelInitializer 的 handelrAdded 方法，在该方法中执行 initChannel 方法，用户自定义的初始化逻辑就封装在这里面。在初始化完 pipeline 后，将 ChannelInitializer 从 pipeline 中删除，并回调其 handlerRemoved 方法。

至此客户端 NioSocketChannel 中 pipeline 初始化工作就全部完成了。

## 总结

本文涉及到的内容比较多，通过 netty 异步事件在 pipeline 中的编排和传播这条主线，我们相当于将之前的文章内容重新又回顾总结了一遍。

本文中我们详细介绍了 pipeline 的组成结构，它主要是由 ChannelHandlerContext 类型节点组成的双向链表。ChannelHandlerContext 包含了 ChannelHandler 执行上下文的信息，从而可以使 ChannelHandler 只关注于 IO 事件的处理，遵循了单一原则和开闭原则。

此外 pipeline 结构中还包含了一个任务链表，用来存放执行 ChannelHandler 中的 handlerAdded 回调和 handlerRemoved 回调。pipeline 还持有了所属 channel 的引用。

我们还详细介绍了 Netty 中异步事件的分类：Inbound 类事件，Outbound 类事件，ExceptionCaught 事件。并详细介绍了每种分类下的所有事件的触发时机和在 pipeline 中的传播路径。

最后介绍了 pipeline 的结构以及创建和初始化过程，以及对 pipeline 相关操作的源码实现。

中间我们又穿插介绍了 ChannelHanderContext 的结构，介绍了 ChannelHandlerContext 具体封装了哪些关于 ChannelHandler 执行的上下文信息。

本文的内容到这里就结束了，感谢大家的观看，我们下篇文章见~~~