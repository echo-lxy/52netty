# 分拣流水线：Pipeline

## Pipeline 简介

### 依赖关系简介

我们常提到的`Netty` 中的 `Pipeline` 实际上就是 `ChannelPipeline` 接口的实现。我们来看看其类依赖关系：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410302103381.png" alt="image-20241030210307314" style="zoom:50%;" />



* **`ChannelInboundInvoker` 和 `ChannelOutboundInvoker`**：
  `ChannelPipeline` 是一个链式处理器，用于处理 `Channel` 中的不同入站和出站事件。通过继承 `ChannelInboundInvoker` 和 `ChannelOutboundInvoker` 接口，`ChannelPipeline` 能够直接调用这些接口中的方法，例如 `fireChannelRead()` 和 `write()` 等。这种设计将操作 `Channel` 的入口统一，使得 `ChannelPipeline` 可以同时处理入站和出站事件。
* **`Iterable<ChannelHandler>`**：
  `ChannelPipeline` 实现了 `Iterable<ChannelHandler>` 接口，主要目的是简化遍历，允许开发者轻松遍历 `ChannelPipeline` 中的所有 `ChannelHandler`。这种设计便于对每个 `ChannelHandler` 进行操作、分析或调试。
* **`DefaultChannelPipeline`**：
  `DefaultChannelPipeline` 是 `ChannelPipeline` 接口的唯一实现类，负责处理实际的事件和任务链。

通过这些设计，`Netty` 提供了一个灵活且高效的管道机制，能够处理网络通信中的各种复杂场景。

### ChannelPipeline 源码注释

**ChannelPipeline 的类注释中的核心点如下：**

- **基本概念**
  `ChannelPipeline` 是一个 `ChannelHandler` 列表，用于处理和拦截入站事件和出站操作。它实现了 **拦截过滤器模式**，允许用户完全控制事件处理流程及 `ChannelHandler` 之间的交互。
- **创建**
  每个 `Channel` 会自动创建一个 `ChannelPipeline`，并在新通道生成时初始化。
- **事件流动**
  - **入站事件**：通过 `ChannelInboundHandler` 自底向上处理，通常由 I/O 线程读取。
  - **出站事件**：通过 `ChannelOutboundHandler` 自顶向下处理，通常涉及写请求操作。
- **事件传播**
  使用 `ChannelHandlerContext` 中定义的方法（如 `fireChannelRead()` 和 `write()`）来将事件传递给下一个处理器。事件只在相关的处理器中处理，未处理的事件可能会被丢弃或记录。
- **管道构建**
  `ChannelPipeline` 应包含多个 `ChannelHandler`，例如：
  - **协议解码器**：将二进制数据转化为 Java 对象。
  - **协议编码器**：将 Java 对象转化为二进制数据。
  - **业务逻辑处理器**：执行具体的业务逻辑（如数据库访问）。
- **线程安全**
  `ChannelPipeline` 是线程安全的，允许在运行时动态添加或移除 `ChannelHandler`，例如在敏感信息交换前后插入和移除加密处理器。

------

`ChannelPipeline` 管理的 `ChannelHandler` 集合处理 `I/O` 事件的流程图如下：

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

可以看出，`ChannelPipeline` 将管理的 `ChannelHandler` 分为两种类型：

- **`ChannelInboundHandler` 处理入站事件**

  > - 入站事件是被动接收的事件，例如接收远端数据、通道注册成功、通道变为活跃等。
  > - 入站事件的流向是从 `ChannelPipeline` 管理的 `ChannelInboundHandler` 列表的头部到尾部。因为入站事件通常由远端发送，所以流向是从头到尾。
  > - 采用拦截器模式，由 `ChannelInboundHandler` 决定是否将事件传递给列表中的下一个 `ChannelInboundHandler`。

- **`ChannelOutboundHandler` 处理出站事件**

  > - 出站事件是主动触发的事件，例如绑定、注册、连接、断开、写入等。
  > - 出站事件的流向是从 `ChannelPipeline` 管理的 `ChannelOutboundHandler` 列表的尾部到头部。因为出站事件最终要发送到远端，所以流向是从尾到头。
  > - 采用拦截器模式，由 `ChannelOutboundHandler` 决定是否将事件传递给列表中的下一个 `ChannelOutboundHandler`（由于流向是从尾到头，这里的“下一个”实际上是列表中的上一个）。

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

虽然 `ChannelPipeline` 有许多方法，但可以将其主要分为两类：

1. **管理 `ChannelHandler` 相关的方法**
   这些方法主要用于向管道 `ChannelPipeline` 添加、删除、替换、查找 `ChannelHandler`。
2. **继承自 `ChannelInboundInvoker` 和 `ChannelOutboundInvoker` 的方法**
   这些方法用于发送入站和出站事件。

> 这两个接口与入站事件处理接口 `ChannelInboundHandler` 和出站事件处理接口 `ChannelOutboundHandler` 紧密相关。
>
> - `ChannelInboundInvoker` 用于发送入站事件；
> - `ChannelOutboundInvoker` 用于发送出站事件。

在 `ChannelPipeline` 的实现中：

1. **入站事件处理：**
   由 `ChannelInboundInvoker` 发送的入站事件，会直接通过管道管理的 `ChannelInboundHandler` 列表从头到尾触发。采用拦截器模式，由 `ChannelInboundHandler` 决定是否继续调用下一个 `ChannelInboundHandler` 进行处理。
2. **出站事件处理：**
   由 `ChannelOutboundInvoker` 发送的出站事件，会直接通过管道管理的 `ChannelOutboundHandler` 列表从尾到头触发。采用拦截器模式，由 `ChannelOutboundHandler` 决定是否继续调用下一个 `ChannelOutboundHandler` 进行处理。

### 管理 `ChannelHandler`

通过对 `AbstractChannelHandlerContext` 的分析，我们知道，实际上 `ChannelPipeline` 是通过 **双向链表** 来存储任务处理器的上下文列表的。

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

`DefaultChannelPipeline` 使用成员属性 `head` 表示双向链表的头节点，`tail` 表示双向链表的尾节点。这两个节点在管道创建时会同时被创建并赋值。通过这两个节点，可以从头到尾或者从尾到头遍历整个链表中的节点。

头尾节点的详细说明可以参考 `ChannelHandlerContext` 相关部分【TODO】。

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

- 可以向管道 `ChannelPipeline` 的头部或尾部插入一个或多个 `ChannelHandler`。
- 也可以在管道 `ChannelPipeline` 中，基于已存在的某个 `ChannelHandler`（通过 `baseName` 查找到），在其之前或之后插入一个新的 `ChannelHandler`。

你可能会注意到，每个添加方法都有一个对应的 `EventExecutorGroup` 参数。那么，这个参数的作用是什么呢？

- 我们知道，通道 `Channel` 会注册到一个事件轮询器 `EventLoop` 中，通道的所有 `IO` 事件都是通过这个事件轮询器来处理的。
- 默认情况下，通道 `Channel` 对应的管道 `ChannelPipeline` 所管理的所有 `ChannelHandler` 也是在这个事件轮询器中执行的。
- 这就意味着，`ChannelHandler` 中的操作不能包含过于耗时的任务，特别是不能包含阻塞操作。否则，这会导致整个事件轮询器被阻塞，从而影响所有注册到该事件轮询器的通道的 `IO` 事件处理，以及事件轮询器中的所有待执行任务和计划任务。
- 那么，如果确实有需要执行耗时或阻塞操作的需求该怎么办呢？为了解决这个问题，`ChannelPipeline` 提供了一个额外的 `EventExecutorGroup` 参数的方法。使用这个方法，可以将指定的 `ChannelHandler` 中的所有方法交给指定的 `EventExecutorGroup` 来执行，这样就不会阻塞通道 `Channel` 对应的事件轮询器了。

#### 删除

#### 替换

```Java
ChannelPipeline replace(ChannelHandler oldHandler, String newName, ChannelHandler newHandler);

ChannelHandler replace(String oldName, String newName, ChannelHandler newHandler);

<T extends ChannelHandler> T replace(Class<T> oldHandlerType, String newName,ChannelHandler newHandler);
```

- 用新的 `newHandler` 替换该管道中指定老的 `oldHandler`。
- 用新的 `newHandler` 替换该管道中指定名称`oldName`或者指定类型`oldHandlerType` 对应的老 `ChannelHandler`, 并返回它。

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

- 检查新事件处理器的重复性和新名称的重复性
- 创建新事件处理器 `newHandler` 对应的上下文
- 通过 `replace0(ctx, newCtx)` 方法，用新的上下文替换老的上下文。
- 最后改变改变新老上下文的状态，而且必须先将新的上下文状态变成 `ADD_COMPLETE`， 然后再将老的上下文状态变成 `REMOVE_COMPLETE`。

#### 查找

```Java
ChannelHandler get(String name);
<T extends ChannelHandler> T get(Class<T> handlerType);

ChannelHandlerContext context(ChannelHandler handler);
ChannelHandlerContext context(String name);
ChannelHandlerContext context(Class<? extends ChannelHandler> handlerType);
```

- 根据名字或者类型从管道中查找对应的 `ChannelHandler` 对象。
- 根据 `ChannelHandler` 或者名字或者类型从管道中查找对应的 `ChannelHandlerContext` 对象。
- 其实管道`ChannelPipeline` 存储的是`ChannelHandlerContext` 对象，它是由 `ChannelHandler` 对象创建的，可以通过`ChannelHandlerContext`直接获取`ChannelHandler` 。

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

都是从双向链表头开始遍历，找到了就返回这个上下文，如果遍历到最后都没有找到，就返回 `null`。

#### 其他

```Java
ChannelHandler first();
ChannelHandlerContext firstContext();

ChannelHandler last();
ChannelHandlerContext lastContext();

List<String> names();
Map<String, ChannelHandler> toMap();
```

- 获取管道头或者尾的 `ChannelHandler` 以及 `ChannelHandlerContext` 对象。
- 获取管道拥有的 `ChannelHandler` 名称的列表。
- 获取此管道拥有的 `ChannelHandler` 集合。

### 拦截 `IO` 事件

详见 [《货物：被传播的 IO 事件》](/netty_source_code_parsing/main_task/service_orchestration_layer/io_event)



## 核心行为

### 构造方法

![image-20241031192538897](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311925136.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)



Netty 会为每一个 `Channel` 分配一个独立的 `pipeline`，并且 `pipeline` 会伴随着 `channel` 的创建而创建。

之前提到，`NioServerSocketChannel` 是在 Netty 服务端启动过程中创建的。而 `NioSocketChannel` 的创建发生在当 `NioServerSocketChannel` 上的 `OP_ACCEPT` 事件活跃时，由主 reactor 线程在 `NioServerSocketChannel` 中创建，并在 `NioServerSocketChannel` 的 `pipeline` 中对 `OP_ACCEPT` 事件进行编排时（如图中的 `ServerBootstrapAcceptor` 中）初始化。

无论是创建 `NioServerSocketChannel` 中的 `pipeline`，还是创建 `NioSocketChannel` 中的 `pipeline`，最终都会委托给它们的父类 `AbstractChannel`。

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

在之前的系列文章中，`pipeline` 结构被多次提到。它是由 `ChannelHandlerContext` 类型的节点构成的双向链表。链表的头结点是 `HeadContext`，尾结点是 `TailContext`。其初始结构如下所示：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311927150.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031192717093" style="zoom: 50%;" />

### 通过 ChannelInitializer 向 pipeline 添加 channelHandler

在详细介绍了所有的 inbound 类事件和 outbound 类事件的掩码表示，以及事件的触发和传播路径之后，相信大家现在可以通过 `ChannelInboundHandler` 和 `ChannelOutboundHandler` 来根据具体的业务场景，选择合适的 `ChannelHandler` 类型，并监听相关事件以完成业务需求。

本小节将介绍自定义的 `ChannelHandler` 是如何添加到 `pipeline` 中的，Netty 在这个过程中为我们做了哪些工作。

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

以上是 echo 简化的一个 Netty 服务端配置 `ServerBootstrap` 启动类的示例代码。我们可以看到，向 `channel` 对应的 `pipeline` 中添加 `ChannelHandler` 是通过 `ChannelPipeline#addLast` 方法将指定的 `ChannelHandler` 添加到 `pipeline` 的末尾。

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

最终，`addLast` 的这些重载方法都会调用到 `DefaultChannelPipeline#addLast(EventExecutorGroup, String, ChannelHandler)` 这个方法，从而完成 `ChannelHandler` 的添加。

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

这个方法的逻辑比较复杂，涉及到许多细节。为了更清晰地讲解，笔者采用了总分总的结构：首先描述该方法的总体逻辑，然后针对核心细节展开详细分析。

由于向 `pipeline` 中添加 `ChannelHandler` 的操作可能会在多个线程中进行，为了确保添加操作的线程安全性，Netty 采用了一个 `synchronized` 语句块将整个添加逻辑包裹起来。

1. 通过 `checkMultiplicity` 方法，Netty 检查被添加的 `ChannelHandler` 是否是共享的（即是否标注了 `@Sharable` 注解）。如果该 `ChannelHandler` 不是共享的，那么 **同一实例** 将无法被添加到多个 `pipeline` 中。如果该 `ChannelHandler` 是共享的，则允许 **同一个实例** 被多次添加到多个 `pipeline` 中。

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

这里大家需要注意的是，如果一个 `ChannelHandler` 被标注了 `@Sharable` 注解，这意味着它的一个实例可以被多次添加进多个 `pipeline` 中（每个 `channel` 对应一个 `pipeline` 实例）。然而，这些不同的 `pipeline` 可能会由不同的 reactor 线程执行。因此，在使用共享的 `ChannelHandler` 时，需要确保其线程安全性。

例如，下面是一个实例代码：

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

`EchoServerHandler` 是我们自定义的 `ChannelHandler`，它被 `@Sharable` 注解标注，意味着它在全局范围内只有一个实例，并且可以被添加到多个 `Channel` 的 `pipeline` 中。这样，这个实例就会被多个 reactor 线程执行。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311933766.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031193319618" style="zoom:50%;" />

2. 为 `ChannelHandler` 创建其对应的 `ChannelHandlerContext`，用于封装 `ChannelHandler` 的名称、状态信息、执行上下文信息，以及感知 `ChannelHandler` 在 `pipeline` 中的位置信息。`newContext` 方法涉及的细节较多，后面我们会单独介绍。
3. 通过 `addLast0` 将新创建的 `ChannelHandlerContext` 插入到 `pipeline` 的末尾。这个方法的逻辑其实很简单，基本上就是一个普通的双向链表插入操作。

```java
private void addLast0(AbstractChannelHandlerContext newCtx) {
    AbstractChannelHandlerContext prev = tail.prev;
    newCtx.prev = prev;
    newCtx.next = tail;
    prev.next = newCtx;
    tail.prev = newCtx;
}
```

::: warning 注意

虽然此时 `ChannelHandlerContext` 已经被物理地插入到 `pipeline` 中，但此时 `ChannelHandler` 的状态依然是 `INIT` 状态。从逻辑上来说，它并没有真正被插入到 `pipeline` 中。只有等到 `ChannelHandler` 的 `handlerAdded` 方法被回调时，它的状态才会变为 `ADD_COMPLETE`。而只有在 `ADD_COMPLETE` 状态下的 `ChannelHandler` 才能响应 `pipeline` 中传播的事件。

:::

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311943799.png)



在[《处理 OP_WRITE 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_WRITE)中的《触发nextChannelHandler的flush方法回调》小节中，我们也提到过，在每次 `write` 事件或 `flush` 事件传播时，都需要通过 `invokeHandler` 方法来判断 `ChannelHandler` 的状态是否为 `ADD_COMPLETE`。如果状态不为 `ADD_COMPLETE`，则当前的 `ChannelHandler` 无法响应正在 `pipeline` 中传播的事件。**必须等到对应的 `handlerAdded` 方法被回调后，才可以处理事件，因为 `handlerAdded` 方法中可能包含一些 `ChannelHandler` 初始化的重要逻辑。**

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

事实上，不仅仅是 `write` 事件和 `flush` 事件在传播时需要判断 `ChannelHandler` 的状态，所有的 inbound 类事件和 outbound 类事件在传播时都需要通过 `invokeHandler` 方法来判断当前 `ChannelHandler` 的状态是否为 `ADD_COMPLETE`，以确保在 `ChannelHandler` 响应事件之前，它的 `handlerAdded` 方法已经被回调。

4. 如果在向 `pipeline` 中添加 `ChannelHandler` 时，`channel` 还未注册到 `reactor` 中，那么需要将当前 `ChannelHandler` 的状态设置为 `ADD_PENDING`，并将回调该 `ChannelHandler` 的 `handlerAdded` 方法封装成 `PendingHandlerAddedTask` 任务，添加到 `pipeline` 中的任务列表中。等到 `channel` 注册到 `reactor` 后，`reactor` 线程会依次执行 `pipeline` 中任务列表中的任务。

这段逻辑主要用于处理 `ChannelInitializer` 的添加场景，因为目前只有 `ChannelInitializer` 这个特殊的 `ChannelHandler` 会在 `channel` 尚未注册之前被添加进 `pipeline` 中。

```java
if (!registered) {
    newCtx.setAddPending();
    callHandlerCallbackLater(newCtx, true);
    return this;
}
```

向 `pipeline` 的任务列表 `pendingHandlerCallbackHead` 中添加 `PendingHandlerAddedTask` 任务的过程如下：

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

`PendingHandlerAddedTask` 任务负责回调 `ChannelHandler` 中的 `handlerAdded` 方法。

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

5. 除了 `ChannelInitializer` 这个特殊的 `ChannelHandler` 的添加是在 channel 向 reactor 注册之前外，其他用户自定义的 `ChannelHandler` 都是在 channel 向 reactor 注册之后被添加进 pipeline 的。

   在这种场景下的处理会变得比较简单，因为一旦 `ChannelHandler` 被插入到 pipeline 中，就会立即回调该 `ChannelHandler` 的 `handlerAdded` 方法。**但需要确保 `handlerAdded` 方法的回调是在 channel 指定的 executor 中进行的。**

```java
EventExecutor executor = newCtx.executor();
if (!executor.inEventLoop()) {
    callHandlerAddedInEventLoop(newCtx, executor);
    return this;
}  

callHandlerAdded0(newCtx);
```

如果当前执行线程并不是 `ChannelHandler` 指定的 executor (`!executor.inEventLoop()`)，那么就需要确保 `handlerAdded` 方法的回调在 channel 指定的 executor 中进行。

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

这里需要注意的是，在回调 `handlerAdded` 方法之前，需要将 `ChannelHandler` 的状态提前设置为 `ADD_COMPLETE`。这是因为用户可能在 `ChannelHandler` 中的 `handlerAdded` 回调中触发一些事件。如果此时 `ChannelHandler` 的状态不是 `ADD_COMPLETE`，就会停止对事件的响应，从而错过事件的处理。

这种情况属于用户的极端使用场景。

```java
final void callHandlerAdded() throws Exception {
    if (setAddComplete()) {
        handler().handlerAdded(this);
    }
}
```

### 删除 ChannelHandler

从上个小节的内容中我们可以看到，向 pipeline 中添加 `ChannelHandler` 的逻辑还是比较复杂的，涉及的细节较多。

在了解了向 pipeline 中添加 `ChannelHandler` 的过程之后，从 pipeline 中删除 `ChannelHandler` 的逻辑就变得相对容易理解了。

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

Netty 提供了以上三种方式从 pipeline 中删除指定的 `ChannelHandler`。下面我们以第一种方式为例，来介绍 `ChannelHandler` 的删除过程。

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

首先，需要通过 `getContextOrDie` 方法在 pipeline 中查找到指定的 `ChannelHandler` 对应的 `ChannelHandlerContext`，以确认要删除的 `ChannelHandler` 确实存在于 pipeline 中。

`context` 方法是通过遍历 pipeline 中的双向链表来查找要删除的 `ChannelHandlerContext`。

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

`remove` 方法的整体代码结构和 `addLast0` 方法的代码结构类似，整体逻辑也是先从 pipeline 中的双向链表结构中将指定的 `ChannelHandlerContext` 删除，然后再处理被删除的 `ChannelHandler` 中 `handlerRemoved` 方法的回调。

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

1. 从 pipeline 中删除指定的 `ChannelHandler` 对应的 `ChannelHandlerContext`，逻辑比较简单，就是普通双向链表的删除操作。

```java
private synchronized void atomicRemoveFromHandlerList(AbstractChannelHandlerContext ctx) {
    AbstractChannelHandlerContext prev = ctx.prev;
    AbstractChannelHandlerContext next = ctx.next;
    prev.next = next;
    next.prev = prev;
}
```

2. 如果此时 channel 并未向对应的 reactor 进行注册，则需要向 pipeline 的任务列表中添加 `PendingHandlerRemovedTask` 任务。在该任务中，会执行 `ChannelHandler` 的 `handlerRemoved` 回调。当 channel 向 reactor 注册成功后，reactor 会执行 pipeline 中任务列表中的任务，从而回调被删除的 `ChannelHandler` 的 `handlerRemoved` 方法。

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

在执行 `ChannelHandler` 中的 `handlerRemoved` 回调时，需要对 `ChannelHandler` 的状态进行判断：只有当 `handlerState` 为 `ADD_COMPLETE` 时，才可以回调 `handlerRemoved` 方法。

这里表达的语义是，只有当 `ChannelHandler` 的 `handlerAdded` 方法被回调之后，在 `ChannelHandler` 被从 pipeline 中删除时，它的 `handlerRemoved` 方法才可以被回调。

在 `ChannelHandler` 的 `handlerRemoved` 方法被回调之后，将 `ChannelHandler` 的状态设置为 `REMOVE_COMPLETE`。

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

3. 如果 channel 已经在 reactor 中注册成功，那么当 `ChannelHandler` 从 pipeline 中删除之后，需要立即回调其 `handlerRemoved` 方法。**但需要确保 `handlerRemoved` 方法在 `ChannelHandler` 指定的 executor 中进行。**

### ChanneHandlerContext 的创建

我们在文章开头提到过这样一句话：

> 其实它（pipeline）唯一被创建的地方，就是当一个 `ChannelHandler` 添加到管道 `ChannelPipeline` 时，由 `ChannelPipeline` 创建一个包裹 `ChannelHandler` 的上下文 `ChannelHandlerContext` 对象添加进去。

接下来，我们看看 `ChannelPipeline#addFirst(String name, ChannelHandler handler)` 方法的实现。

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

1. 由于添加 `ChannelHandler` 会在任何线程中调用，因此使用 `synchronized` 锁来防止并发修改问题。

2. 通过 `checkMultiplicity(handler)` 方法检查这个 `handler` 是否有重复。

3. 通过 `filterName(name, handler)` 方法判断这个名字在当前管道中是否重复。

4. 通过 `newContext(group, name, handler)` 创建这个事件处理器 `ChannelHandler` 对应的上下文对象。

5. 通过 `addFirst0(newCtx)` 方法将新建的上下文对象添加到管道中。

6. 下面是关于新建上下文状态和 `ChannelHandler.handlerAdded(...)` 方法调用问题的处理，分为几种情况：

   > - 当管道对应的通道还没有注册到 `eventLoop` 时，`handlerAdded(...)` 现在还不能被调用；此时将上下文状态变成 `ADD_PENDING`，并添加一个任务，保证当通道添加后，再将状态变成 `ADD_COMPLETE` 并调用 `handlerAdded(...)` 方法。
   > - 当前线程不是新创建上下文执行器线程时，也将上下文状态变成 `ADD_PENDING`，并在上下文执行器线程中调用 `callHandlerAdded0` 方法。
   > - 若不是上述情况，直接调用 `callHandlerAdded0` 方法，将状态变成 `ADD_COMPLETE` 并调用 `handlerAdded(...)` 方法。

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

检查 `ChannelHandler` 是否重复，只有被 `@Sharable` 注解的`ChannelHandler` 才可以多次添加到一个或多个管道 `ChannelPipeline`。

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

在 `pipeline` 中使用了一个 `FastThreadLocal` 类型的 `nameCaches` 来缓存各种类型的 `ChannelHandler` 的基础名称。后面会根据这个基础名称不断地重试生成一个没有冲突的正式名称。缓存 `nameCaches` 中的 key 表示特定的 `ChannelHandler` 类型，value 表示该特定类型的 `ChannelHandler` 的基础名称 `simpleClassName + #0`。

自动为 `ChannelHandler` 生成默认名称的逻辑如下：

- 首先从缓存 `nameCaches` 获取当前添加的 `ChannelHandler` 的基础名称 `simpleClassName + #0`。
- 如果该基础名称 `simpleClassName + #0` 在 pipeline 中是唯一的，那么就将该基础名称作为 `ChannelHandler` 的名称。
- 如果缓存的基础名称在 pipeline 中不是唯一的，则不断地增加名称后缀，如 `simpleClassName#1`, `simpleClassName#2`, ... , `simpleClassName#n`，直到产生一个没有重复的名称。

虽然用户不太可能将同一类型的 `ChannelHandler` 重复添加到 `pipeline` 中，但 Netty 为了防止这种反复添加同一类型 `ChannelHandler` 的行为导致的名称冲突，利用 `nameCaches` 来缓存同一类型 `ChannelHandler` 的基础名称 `simpleClassName + #0`。然后，通过不断递增名称后缀，生成一个在 `pipeline` 中唯一的名称。

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

通过前边的介绍我们了解到，当我们向 pipeline 添加 `ChannelHandler` 时，Netty 允许我们为 `ChannelHandler` 指定特定的 executor 来执行 `ChannelHandler` 中的各种事件回调方法。

通常，我们会为 `ChannelHandler` 指定一个 `EventExecutorGroup`，在创建 `ChannelHandlerContext` 时，会通过 `childExecutor` 方法从 `EventExecutorGroup` 中选取一个 `EventExecutor` 来与该 `ChannelHandler` 绑定。

`EventExecutorGroup` 是 Netty 自定义的一个线程池模型，其中包含多个 `EventExecutor`，而 `EventExecutor` 在 Netty 中是一个线程的执行模型。相关的具体实现和用法 echo 已经在[《BootStrap 初始化 Netty 服务》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_init)一文中给出了详尽的介绍，忘记的同学可以回顾一下。

在介绍 executor 的绑定逻辑之前，echo 需要先为大家介绍一个相关的重要参数：`SINGLE_EVENTEXECUTOR_PER_GROUP`，默认为 `true`。

```java
ServerBootstrap b = new ServerBootstrap();
b.group(bossGroup, workerGroup)
.channel(NioServerSocketChannel.class)
  .........
.childOption(ChannelOption.SINGLE_EVENTEXECUTOR_PER_GROUP,true）
```

我们知道在 Netty 中，每一个 `Channel` 都会对应一个独立的 `pipeline`。如果我们开启了 `SINGLE_EVENTEXECUTOR_PER_GROUP` 参数，表示在一个 `channel` 对应的 `pipeline` 中，如果我们为多个 `ChannelHandler` 指定了同一个 `EventExecutorGroup`，那么这多个 `ChannelHandler` 只能绑定到 `EventExecutorGroup` 中的同一个 `EventExecutor` 上。

这是什么意思呢？举个例子，比如我们有下面一段初始化 `pipeline` 的代码：

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

`EventExecutorGroup` 中包含 `EventExecutor1`、`EventExecutor2`、`EventExecutor3` 三个执行线程。

假设此时第一个连接进来，在创建 `channel1` 后初始化 `pipeline1` 的时候，如果开启了 `SINGLE_EVENTEXECUTOR_PER_GROUP` 参数，那么在 `channel1` 对应的 `pipeline1` 中，`channelHandler1`、`channelHandler2`、`channelHandler3` 绑定的 `EventExecutor` 均为 `EventExecutorGroup` 中的 `EventExecutor1`。

第二个连接 `channel2` 对应的 `pipeline2` 中，`channelHandler1`、`channelHandler2`、`channelHandler3` 绑定的 `EventExecutor` 均为 `EventExecutorGroup` 中的 `EventExecutor2`。

第三个连接 `channel3` 对应的 `pipeline3` 中，`channelHandler1`、`channelHandler2`、`channelHandler3` 绑定的 `EventExecutor` 均为 `EventExecutorGroup` 中的 `EventExecutor3`。

以此类推……

![image-20241031194308770](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311943399.png)

如果在关闭 `SINGLE_EVENTEXECUTOR_PER_GROUP` 参数的情况下，`channel1` 对应的 `pipeline1` 中，`channelHandler1` 会绑定到 `EventExecutorGroup` 中的 `EventExecutor1`，`channelHandler2` 会绑定到 `EventExecutor2`，`channelHandler3` 会绑定到 `EventExecutor3`。

同理，其他 `channel` 对应的 `pipeline` 中的 `channelHandler` 绑定逻辑也同 `channel1`。它们将分别绑定到 `EventExecutorGroup` 中的不同 `EventExecutor`，每个 `ChannelHandler` 都会选择不同的 `EventExecutor`，而不是所有 `ChannelHandler` 绑定到同一个 `EventExecutor`。

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

如果我们并未特殊指定 `ChannelHandler` 的 executor，那么默认情况下，将由对应 `channel` 绑定的 reactor 线程负责执行该 `ChannelHandler`。

如果我们未开启 `SINGLE_EVENTEXECUTOR_PER_GROUP`，Netty 会从我们指定的 `EventExecutorGroup` 中，按照 round-robin 的方式为每个 `ChannelHandler` 绑定其中一个 `EventExecutor`。这种方式确保每个 `ChannelHandler` 都会被分配到 `EventExecutorGroup` 中的一个不同的 `EventExecutor`，并且通过轮询分配负载，避免某个执行线程过载。

![image-20241031194258633](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942958.png)

如果我们开启了 `SINGLE_EVENTEXECUTOR_PER_GROUP`，**相同的 `EventExecutorGroup` 在同一个 `pipeline` 实例中的绑定关系是固定的**。也就是说，在同一个 `pipeline` 中，如果多个 `ChannelHandler` 指定了同一个 `EventExecutorGroup`，那么这些 `ChannelHandler` 的 `executor` 将会绑定到同一个固定的 `EventExecutor` 上。

这种方式保证了同一个 `EventExecutorGroup` 下的 `ChannelHandler` 会共享一个 `EventExecutor`，从而避免了不同的 `ChannelHandler` 在同一个 `pipeline` 中绑定到不同的 `EventExecutor`，保持了线程的绑定一致性。

![image-20241031194253838](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942951.png)



这种固定的绑定关系缓存于每个 `pipeline` 中的 `Map<EventExecutorGroup, EventExecutor>` 字段 `childExecutors` 中，其中，key 是用户为 `ChannelHandler` 指定的 `EventExecutorGroup`，value 是该 `EventExecutorGroup` 在 `pipeline` 实例中的绑定 `EventExecutor`。

接下来的逻辑是从 `childExecutors` 中获取指定 `EventExecutorGroup` 在该 `pipeline` 实例中的绑定 `EventExecutor`。如果绑定关系尚未建立，则通过 round-robin 的方式从 `EventExecutorGroup` 中选取一个 `EventExecutor` 进行绑定，并在 `childExecutors` 中缓存该绑定关系。

如果绑定关系已经建立，则直接为 `ChannelHandler` 指定已经绑定好的 `eventExecutor`。这样，Netty 确保了 `ChannelHandler` 的执行线程在 `EventExecutorGroup` 中的一致性，并且避免了重复选择 `EventExecutor`。

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

其实关于 `pipeline` 初始化的相关内容，我们在[《BootStrap 启动 Netty 服务》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_run)中已经简要介绍了 `NioServerSocketChannel` 中的 `pipeline` 初始化时机以及过程。

在[《处理 OP_ACCEPT 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_ACCEPT)中，笔者也简要介绍了 `NioSocketChannel` 中 `pipeline` 的初始化时机以及过程。

本小节将结合这两种类型的 `Channel` 来完整全面地介绍 `pipeline` 的整个初始化过程。

#### NioServerSocketChannel 中 pipeline 的初始化

从前面提到的这两篇文章以及本文前面的相关内容，我们知道，Netty 提供了一个特殊的 `ChannelInboundHandler`，叫做 `ChannelInitializer`。用户可以利用这个特殊的 `ChannelHandler` 对 `Channel` 中的 `pipeline` 进行自定义的初始化逻辑。

如果用户只希望在 `pipeline` 中添加一个固定的 `ChannelHandler`，可以通过如下代码直接添加：

```java
ServerBootstrap b = new ServerBootstrap();
    b.group(bossGroup, workerGroup)//配置主从Reactor
          ...........
     .handler(new LoggingHandler(LogLevel.INFO))
```

如果希望添加多个 `ChannelHandler`，则可以通过 `ChannelInitializer` 来自定义添加逻辑。

由于使用 `ChannelInitializer` 初始化 `NioServerSocketChannel` 中 `pipeline` 的逻辑会稍微复杂一些，下面我们将以这个复杂的案例来讲述 `pipeline` 的初始化过程。

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

以上这些由用户自定义的用于初始化 `pipeline` 的 `ChannelInitializer` 被保存至 `ServerBootstrap` 启动类中的 `handler` 字段中，用于后续的初始化调用：

```java
public abstract class AbstractBootstrap<B extends AbstractBootstrap<B, C>, C extends Channel> implements Cloneable
   private volatile ChannelHandler handler;
}
```

在服务端启动时，会伴随着 `NioServerSocketChannel` 的创建以及初始化。在初始化 `NioServerSocketChannel` 时，会将一个新的 `ChannelInitializer` 添加进 `pipeline` 中。随后，在这个新的 `ChannelInitializer` 中，才会将用户自定义的 `ChannelInitializer` 添加进 `pipeline`，并执行初始化过程。

Netty 引入一个新的 `ChannelInitializer` 来初始化 `NioServerSocketChannel` 中的 `pipeline` 的原因，是为了兼容前面介绍的两种初始化 `pipeline` 的方式：

- 一种是直接使用一个具体的 `ChannelHandler` 来初始化 `pipeline`。
- 另一种是使用 `ChannelInitializer` 来自定义初始化 `pipeline` 的逻辑。

忘记 Netty 启动过程的同学可以回顾一下[《BootStrap 启动 Netty 服务》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_run)

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

**注意，此时 `NioServerSocketChannel` 并未开始向 Main Reactor 注册**。根据本文第四小节《向 pipeline 添加 channelHandler》中的介绍，向 `pipeline` 中添加这个新的 `ChannelInitializer` 后，Netty 会将一个 `PendingHandlerAddedTask` 添加到 `pipeline` 的任务列表中。当 `NioServerSocketChannel` 向 Main Reactor 注册成功后，紧接着 Main Reactor 线程会调用这个 `PendingHandlerAddedTask`，在任务中会执行新的 `ChannelInitializer` 的 `handlerAdded` 回调。在这个回调方法中，会执行上面 `initChannel` 方法里的代码。

![image-20241031194242762](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942100.png)

当 `NioServerSocketChannel` 在向 **Main Reactor** 注册成功之后，它会依次执行 `pipeline` 中任务列表中的各个任务。

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

执行 pipeline 任务列表中的 `PendingHandlerAddedTask` 任务：

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

最终，在 `PendingHandlerAddedTask` 中会执行 `pipeline` 中 `ChannelInitializer` 的 `handlerAdded` 回调。

这个 `ChannelInitializer` 是在初始化 `NioServerSocketChannel` 的 `init` 方法中，向 `pipeline` 添加的。

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

在 `handlerAdded` 回调中，会执行 `ChannelInitializer` 匿名类中的 `initChannel` 方法。

::: warning 注意

此时执行的 `ChannelInitializer` 类是由 Netty 框架在本小节开头的 `init` 方法中添加的，而不是用户自定义的 `ChannelInitializer`。

:::

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

执行完 `ChannelInitializer` 匿名类中的 `initChannel` 方法后，需要将 `ChannelInitializer` 从 `pipeline` 中删除，并回调 `ChannelInitializer` 的 `handlerRemoved` 方法。删除过程已经在第六小节《从 pipeline 删除 channelHandler》中详细介绍过。

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

当执行完 `initChannel` 方法后，此时 `pipeline` 的结构如下图所示：

![image-20241031194237445](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942628.png)

当用户自定义的 `ChannelInitializer` 被添加进 `pipeline` 后，根据第四小节所讲的添加逻辑，此时 `NioServerSocketChannel` 已经成功注册到 **Main Reactor**，不再需要向 `pipeline` 的任务列表中添加 `PendingHandlerAddedTask` 任务，而是直接调用自定义 `ChannelInitializer` 中的 `handlerAdded` 回调。这个过程与之前的逻辑相同，不同的是，这里最终回调至用户自定义的初始化逻辑，实现 `initChannel` 方法。

执行完用户自定义的初始化逻辑后，会从 `pipeline` 中删除用户自定义的 `ChannelInitializer`。

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

随后，Netty 会以异步任务的形式向 `pipeline` 的末尾添加 `ServerBootstrapAcceptor`。至此，`NioServerSocketChannel` 中 `pipeline` 的初始化工作就全部完成了。

#### NioSocketChannel 中 pipeline 的初始化

在上个小节中笔者举的这个 pipeline 初始化的例子相对来说比较复杂，当我们把这个复杂例子的初始化逻辑搞清楚之后，NioSocketChannel 中 pipeline 的初始化过程就变的很简单了。

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

在[《处理 OP_ACCEPT 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_ACCEPT)一文中我们提到，当客户端发起连接并完成三次握手后，`NioServerSocketChannel` 上的 `OP_ACCEPT` 事件会变为活跃。此时，会在 `NioServerSocketChannel` 的 `pipeline` 中触发 `channelRead` 事件，并最终在 `ServerBootstrapAcceptor` 中初始化客户端的 `NioSocketChannel`。

![image-20241031165217159](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311652414.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

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

在这里，用户自定义的 `ChannelInitializer` 会被添加进 `NioSocketChannel` 中的 `pipeline`。由于此时 `NioSocketChannel` 还没有向 **sub reactor** 注册，所以在向 `pipeline` 中添加 `ChannelInitializer` 的同时，会伴随 `PendingHandlerAddedTask` 被添加进 `pipeline` 的任务列表中。

![image-20241031194226836](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311942014.png)

后面的流程大家应该很熟悉了，与我们在《NioServerSocketChannel 中 pipeline 的初始化》 小节中介绍的一模一样。当 `NioSocketChannel` 向 **sub reactor** 注册成功后，会执行 `pipeline` 中任务列表中的 `PendingHandlerAddedTask` 任务。在 `PendingHandlerAddedTask` 任务中，会回调用户自定义 `ChannelInitializer` 的 `handlerAdded` 方法，在该方法中执行 `initChannel` 方法，用户自定义的初始化逻辑就封装在其中。初始化完 `pipeline` 后，会将 `ChannelInitializer` 从 `pipeline` 中删除，并回调其 `handlerRemoved` 方法。

至此，客户端 `NioSocketChannel` 中 `pipeline` 的初始化工作就全部完成了。

## 总结

本文涉及的内容较为广泛，通过 Netty 异步事件在 `pipeline` 中的编排和传播这一主线，我们相当于回顾并总结了之前的文章内容。

我们详细介绍了 `pipeline` 的组成结构，它主要是由 `ChannelHandlerContext` 类型节点组成的双向链表。`ChannelHandlerContext` 包含了 `ChannelHandler` 执行上下文的信息，从而使得 `ChannelHandler` 只关注于 IO 事件的处理，遵循了单一责任原则和开闭原则。

此外，`pipeline` 结构中还包含了一个任务链表，用来存放执行 `ChannelHandler` 中的 `handlerAdded` 回调和 `handlerRemoved` 回调。`pipeline` 还持有了所属 `channel` 的引用。

我们还详细介绍了 Netty 中异步事件的分类：`Inbound` 类事件、`Outbound` 类事件、`ExceptionCaught` 事件，并详细说明了每种事件的触发时机和在 `pipeline` 中的传播路径。

最后，介绍了 `pipeline` 的结构、创建与初始化过程，以及对 `pipeline` 相关操作的源码实现。

在其中，我们还穿插介绍了 `ChannelHandlerContext` 的结构，具体封装了哪些关于 `ChannelHandler` 执行的上下文信息。

本文内容到此结束，感谢大家的观看，我们下篇文章见~~~