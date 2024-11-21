# 分拣操作台：ChannelHandlerContext

## ChannelHandlerContext 简介

`ChannelHandlerContext` 在 Netty 中是一个用于处理 I/O 事件和管理 ChannelHandler 的上下文对象，它封装了 `Channel` 和 `ChannelPipeline` 相关的信息，并提供了事件传播、属性存储等功能。在构建网络应用时，`ChannelHandlerContext` 能帮助开发者在 `ChannelPipeline` 中管理 `ChannelHandler` 的交互和事件流转。

其实它唯一创建的地方，就是当一个 `ChannelHandler` 添加到管道`ChannelPipeline`时，由`ChannelPipeline`创建一个包裹 `ChannelHandler` 的上下文`ChannelHandlerContext`对象添加进去。

`ChannelHandlerContext` 的类层次结构分为抽象类、接口和具体实现类，其中关键的接口和抽象类如下：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410302140966.png" alt="image-20241030214059917" style="zoom:50%;" />

我们以 ChannelHandlerContext 接口为核心来分析

先来看看接口，在后面会详细介绍各个类

- `ChannelHandlerContext` 包裹这一个 `ChannelHandler`, `ChannelHandlerContext` 必属于一个管道 `ChannelPipeline`。

> - 这些都是在 `ChannelHandlerContext` 创建的时候就绑定的。
> - 因为`ChannelHandlerContext`获取到对应的管道，因此动态修改它所属的`ChannelPipeline`。

- `ChannelHandlerContext` 继承 `ChannelInboundInvoker` 和 `ChannelOutboundInvoker`

> - 表示`ChannelHandlerContext` 也可以发送 `IO` 事件，它可以通知所属的`ChannelPipeline` 最接近的处理程序器处理 `IO` 事件。
> - 对于入站事件，最接近的处理程序器就是当前 `ChannelHandler` 在管道中下一个入站处理器`ChannelInboundHandler`。
> - 对于出站事件，最接近的处理程序器就是当前 `ChannelHandler` 在管道中上一个出站处理器`ChannelOutboundHandler`。
> - 其实 `ChannelPipeline` 的拦截器功能，就是通过`ChannelHandlerContext`实现的，因为由`ChannelHandlerContext`决定是否要调用列表中的下一个处理器处理。

- AttributeMap 接口（详细内容请阅读 【TODO】）

  - `AttributeMap` 接口用于存储和管理 `ChannelHandlerContext` 的一些附加属性。属性的管理是线程安全的，可以用来保存用户会话信息或其他上下文数据，以便在处理不同事件时共享这些信息。其常用方法包括：
    - `attr(AttributeKey<T> key)`：获取指定键的属性。
    - `hasAttr(AttributeKey<T> key)`：检查是否存在指定键的属性。

## ChannelHandlerContext

### 源码注释

`ChannelHandlerContext` 是 Netty 中的一个重要接口，它允许 `ChannelHandler` 与其所属的 `ChannelPipeline` 及其他处理器进行交互。以下是其源码中的核心点总结：

- 事件通知
  - 通过 `ChannelHandlerContext` 可以通知 `ChannelPipeline` 中的下一个 `ChannelHandler`，以此实现事件在管道中的流动。
  - `ChannelPipeline` 控制事件的流向，`ChannelHandlerContext` 作为连接点，方便通知管道中的下一个处理器。
- 动态修改 Pipeline
  - 通过 `pipeline()` 方法可以获取 `ChannelHandler` 所属的 `ChannelPipeline`，并可在运行时插入、移除或替换管道中的处理器，方便实现动态调整。
- 上下文持久化
  - 可以将 `ChannelHandlerContext` 保留用于后续操作。例如，在非处理器方法（甚至不同线程）中触发事件。
- 存储状态信息
  - `attr(AttributeKey)` 方法可以存储和访问与 `ChannelHandler`/`Channel` 关联的状态信息，以便于状态管理和信息共享。
- 多上下文支持
  - 单个 `ChannelHandler` 实例可以被添加到多个 `ChannelPipeline` 中，从而关联多个 `ChannelHandlerContext`。此时，该实例可以通过不同的 `ChannelHandlerContext` 被调用。
  - 为了安全地支持多上下文的场景，应使用 `@Sharable` 注解。

### 核心方法

```Java
public interface ChannelHandlerContext extends AttributeMap, ChannelInboundInvoker, ChannelOutboundInvoker {

    Channel channel(); // 返回与此上下文绑定的 Channel

    EventExecutor executor(); // 返回用于执行任务的 EventExecutor

    String name(); // 返回 ChannelHandlerContext 的唯一名称

    ChannelHandler handler(); // 返回绑定到此上下文的 ChannelHandler

    boolean isRemoved(); // 检查 ChannelHandler 是否已从 ChannelPipeline 中移除

    ChannelPipeline pipeline(); // 返回分配的 ChannelPipeline

    ByteBufAllocator alloc(); // 返回用于分配 ByteBuf 的 ByteBufAllocator

    @Deprecated
    <T> Attribute<T> attr(AttributeKey<T> key); // 获取属性（已弃用）

    @Deprecated
    <T> boolean hasAttr(AttributeKey<T> key); // 检查属性（已弃用）

    // 省略 ChannelInboundInvoker 和 ChannelOutboundInvoker 中的事件触发和方法
    ...
}
```

## AbstractChannelHandlerContext

### 成员属性

【TODO】放图

#### 双向链表

```Java
// 组成双向链表
volatile AbstractChannelHandlerContext next;
volatile AbstractChannelHandlerContext prev;
```

通过 `next` 和 `prev` 组成一个双向链表，这样就可以向上或者向下查找管道中的其他处理器上下文。

#### 上下文状态

```Java
/**
* ChannelHandler.handlerAdded(ChannelHandlerContext) 即将被调用。
*/
private static final int ADD_PENDING = 1;
/**
* ChannelHandler.handlerAdded(ChannelHandlerContext) 已经被调用。
*/
private static final int ADD_COMPLETE = 2;
/**
* ChannelHandler.handlerRemoved(ChannelHandlerContext) 已经被调用。
*/
private static final int REMOVE_COMPLETE = 3;
/**
* 初始状态，
* ChannelHandler.handlerAdded(ChannelHandlerContext) 和
* ChannelHandler.handlerRemoved(ChannelHandlerContext) 都没有被调用。
*
*/
private static final int INIT = 0;

private volatile int handlerState = INIT;

private static final AtomicIntegerFieldUpdater<AbstractChannelHandlerContext> HANDLER_STATE_UPDATER
= AtomicIntegerFieldUpdater.newUpdater(AbstractChannelHandlerContext.class, "handlerState");
```

- 状态一共分为 `4` 种: `INIT`,`ADD_PENDING`,`ADD_COMPLETE`和`REMOVE_COMPLETE`。

- 通过 `handlerState` 和 `HANDLER_STATE_UPDATER`, 采用 `CAS` 的方式原子化更新属性，这样就不用加锁处理并发问题。

【TODO】这些状态有啥用

#### 不可变的属性

即被 final 修饰的属性，在创建 ChannelHandlerContext 对象时就需要赋值。

- DefaultChannelPipeline pipeline：当前上下文所属的管道 `pipeline`, 而且它的类型就定死了是 `DefaultChannelPipeline` 类。
- `name` ：表示上下文的名称
- `ordered` 表示上下文的执行器是不是有序的 【TODO】
- `executor` 上下文的执行器，如果这个值是 null,那么上下文的执行器用的就是所属通道 Channel 的事件轮询器。
- executionMask 表示事件执行器 ChannelHandler 的执行标记，用来判断是否跳过执行器 `ChannelHandler` 的某些事件处理方法。

### 重要方法

#### 构造方法

```Java
AbstractChannelHandlerContext(DefaultChannelPipeline pipeline, EventExecutor executor,
                              String name, Class<? extends ChannelHandler> handlerClass) {
    this.name = ObjectUtil.checkNotNull(name, "name");
    this.pipeline = pipeline;
    this.executor = executor;
    // 调用 ChannelHandlerMask.mask(handlerClass) 方法，获取执行标记
    this.executionMask = mask(handlerClass);
    // 表示上下文的事件执行器是不是有序的，即以有序/串行的方式处理所有提交的任务。
    // executor == null，说明当前上下文用的是通道Channel的 channel().eventLoop()，这个肯定是有序的
    ordered = executor == null || executor instanceof OrderedEventExecutor;
}
```

这个是 `AbstractChannelHandlerContext` **唯一**的构造方法，基本上赋值了它所有的 `final` 属性。

#### 状态相关方法

- 等待添加

  - ```Java
     final void setAddPending() {
         boolean updated = HANDLER_STATE_UPDATER.compareAndSet(this, INIT, ADD_PENDING);
         // 这应该总是为真，因为它必须在 setAddComplete()或 setRemoved()之前调用。
         assert updated;
     }
    ```

  - 将上下文的状态变成等待添加状态 `ADD_PENDING`。

- 已添加

  - ```Java
     final boolean setAddComplete() {
         for (;;) {
             int oldState = handlerState;
             if (oldState == REMOVE_COMPLETE) {
                 return false;
             }
             // 确保当 handlerState 已经是REMOVE_COMPLETE时，我们永远不会更新。
             // oldState 通常是 ADD_PENDING，但当使用不公开排序保证的 EventExecutor 时，也可能是 REMOVE_COMPLETE。
             if (HANDLER_STATE_UPDATER.compareAndSet(this, oldState, ADD_COMPLETE)) {
                 return true;
             }
         }
     }
    ```

  - 通过`for (;;)` 死循环，采用 `CAS` 的方法，将上下文的状态变成已添加`ADD_COMPLETE`。只有已添加状态上下文的事件处理器 `ChannelHandler` 才能处理事件。

  - ```java
     final void callHandlerAdded() throws Exception {

         // 我们必须在调用 handlerAdded 之前调用 setAddComplete，将状态改成 REMOVE_COMPLETE，
         // 否则这个上下文对应的事件处理器将不会处理任何事件，因为状态不允许。
         if (setAddComplete()) {
             handler().handlerAdded(this);
         }
     }
    ```

  - ```Java
     final void callHandlerAdded() throws Exception {

         // 我们必须在调用 handlerAdded 之前调用 setAddComplete。否则，如果 handlerAdded 方法生成任何管道事件，ctx.handler（） 将错过它们，因为状态不允许这样做
         if (setAddComplete()) {
             handler().handlerAdded(this);
         }
     }
    ```

  - 将状态变成已添加，如果设置成功就调用 `handler().handlerAdded(this)` 方法，通知事件处理器已经被添加到管道上了。

- 已删除

  - ```java
     final void setRemoved() {
         handlerState = REMOVE_COMPLETE;
     }

     final void callHandlerRemoved() throws Exception {
         try {
             // 只有 handlerState 状态变成 ADD_COMPLETE 时，才会调用 handler().handlerRemoved(this)；
             // 也就是说 只有之前调用过 handlerAdded(…)方法，之后才会调用handlerRemoved(…) 方法。
             if (handlerState == ADD_COMPLETE) {
                 handler().handlerRemoved(this);
             }
         } finally {
             // 在任何情况下都要将该上下文标记为已删除
             setRemoved();
         }
     }
    ```

  - 将上下文状态变成已删除。如果上下文状态之前的状态是已添加，那么就会调用 `handler().handlerRemoved(this)` 方法。也就是说，只有之前调用过 `handlerAdded(…)`方法，之后才会调用`handlerRemoved(…)` 方法。

#### 发送`IO`事件

##### 发送入站 `IO`事件

```java
    /**
     * 发送注册的IO事件
     */
    @Override
    public ChannelHandlerContext fireChannelRegistered() {
        // 通过 findContextInbound 方法找到下一个入站处理器上下文
        // 通过 invokeChannelRegistered 方法，调用下一个入站处理器的对应事件处理方法
        invokeChannelRegistered(findContextInbound(MASK_CHANNEL_REGISTERED));
        return this;
    }

    /**
     * 保证在上下文 next 的事件执行器线程中调用对应方法
     */
    static void invokeChannelRegistered(final AbstractChannelHandlerContext next) {
        EventExecutor executor = next.executor();
        if (executor.inEventLoop()) {
            // 如果当前线程是 next 事件执行器EventExecutor线程，直接调用
            next.invokeChannelRegistered();
        } else {
            // 如果当前线程不是 next 事件执行器线程，
            // 那么就通过事件执行器EventExecutor 的execute方法，
            // 保证在执行器线程调用
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    next.invokeChannelRegistered();
                }
            });
        }
    }

    /**
     * 调用该上下文拥有的事件处理器 ChannelHandler 的对应方法
     */
    private void invokeChannelRegistered() {
        // 判断当前上下文有没有已经添加到管道上了
        if (invokeHandler()) {
            // 如果已经添加完成了，就调用对应事件处理器方法
            try {
                ((ChannelInboundHandler) handler()).channelRegistered(this);
            } catch (Throwable t) {
                invokeExceptionCaught(t);
            }
        } else {
            // 如果没有添加完成，即状态不是 ADD_COMPLETE，
            // 就继续调用 fire 的方法，让管道下一个处理器处理
            fireChannelRegistered();
        }
    }
```

我们以*注册*的 `IO` 事件为例，发现调用过程：

1. 先通过 `findContextInbound` 方法，找到下一个入站处理器上下文。
2. 再调用 `invokeChannel...` 系列静态方法，保证处理器方法的调用是在它的上下文事件执行器 `EventExecutor` 线程中。
3. 最后通过 `invokeChannel...` 系列成员方法，调用该上下文拥有的事件处理器 `ChannelHandler` 的对应方法。

> 要通过 `invokeHandler()` 方法判断该上下文是否已经添加到管道上，只有已经完全添加的上下文才能处理事件。

##### 发送出站`IO`操作

```java
    /**
     * 发送绑定 IO 操作
     */
    @Override
    public ChannelFuture bind(final SocketAddress localAddress, final ChannelPromise promise) {
        ObjectUtil.checkNotNull(localAddress, "localAddress");
        // 检查 promise 是否有效
        if (isNotValidPromise(promise, false)) {
            // 返回 true， 说明已取消，直接返回，不做下面的处理
            return promise;
        }

        // 通过 findContextOutbound  方法找到上一个出站处理器上下文
        final AbstractChannelHandlerContext next = findContextOutbound(MASK_BIND);
        // 保证在上下文 next 的事件执行器线程中调用对应方法
        EventExecutor executor = next.executor();
        if (executor.inEventLoop()) {
            next.invokeBind(localAddress, promise);
        } else {
            safeExecute(executor, new Runnable() {
                @Override
                public void run() {
                    next.invokeBind(localAddress, promise);
                }
            }, promise, null, false);
        }
        return promise;
    }

    private void invokeBind(SocketAddress localAddress, ChannelPromise promise) {
        // 判断当前上下文有没有已经添加到管道上了
        if (invokeHandler()) {
            // 如果已经添加完成了，就调用对应事件处理器方法
            try {
                ((ChannelOutboundHandler) handler()).bind(this, localAddress, promise);
            } catch (Throwable t) {
                notifyOutboundHandlerException(t, promise);
            }
        } else {
            // 如果没有添加完成，即状态不是 ADD_COMPLETE，
            // 就继续调用 fire 的方法，让管道下一个处理器处理
            bind(localAddress, promise);
        }
    }
```

我们以绑定 `IO` 事件为例，你会发现调用流程和入站事件差不多，只不过出站事件没有中间那个静态方法。【TODO】为什么需要静态方法

##### invokeTasks 作用

你会发现有的入站和出站事件的处理，与上面的流程不一样，有四个事件:

- `channelReadComplete` 读完成的入站事件
- `channelWritabilityChanged` 可读状态改变的入站事件
- `read` 设置读的出站事件
- `flush` 刷新数据的出站事件

```java
    public ChannelHandlerContext fireChannelReadComplete() {
        invokeChannelReadComplete(findContextInbound(MASK_CHANNEL_READ_COMPLETE));
        return this;
    }

    static void invokeChannelReadComplete(final AbstractChannelHandlerContext next) {
        EventExecutor executor = next.executor();
        if (executor.inEventLoop()) {
            next.invokeChannelReadComplete();
        } else {
            Tasks tasks = next.invokeTasks;
            if (tasks == null) {
                next.invokeTasks = tasks = new Tasks(next);
            }
            executor.execute(tasks.invokeChannelReadCompleteTask);
        }
    }

    private void invokeChannelReadComplete() {
        if (invokeHandler()) {
            try {
                ((ChannelInboundHandler) handler()).channelReadComplete(this);
            } catch (Throwable t) {
                invokeExceptionCaught(t);
            }
        } else {
            fireChannelReadComplete();
        }
    }
```

> 你会发现发送读完成事件的处理过程和上面有区别，不同的是：
>
> - 上面是通过 `executor.execute(new Runnable())`，每次都创建新的 `Runnable` 对象。
> - 而这里是通过一个 `invokeTasks` 对象，不用每次都创建新的 `Runnable` 对象，减少对象创建的实例。

```java
 private static final class Tasks {
        private final AbstractChannelHandlerContext next;
        // `channelReadComplete` 读完成的入站事件
        private final Runnable invokeChannelReadCompleteTask = new Runnable() {
            @Override
            public void run() {
                next.invokeChannelReadComplete();
            }
        };

        // `read` 设置读的出站事件
        private final Runnable invokeReadTask = new Runnable() {
            @Override
            public void run() {
                next.invokeRead();
            }
        };

        // `channelWritabilityChanged` 可读状态改变的入站事件
        private final Runnable invokeChannelWritableStateChangedTask = new Runnable() {
            @Override
            public void run() {
                next.invokeChannelWritabilityChanged();
            }
        };

        // `flush` 刷新数据的出站事件
        private final Runnable invokeFlushTask = new Runnable() {
            @Override
            public void run() {
                next.invokeFlush();
            }
        };

        Tasks(AbstractChannelHandlerContext next) {
            this.next = next;
        }
    }
```

为什么这四个事件可以呢？

> - 你仔细观察，这四个事件都没有参数，也就是说每次调用的时候，没有变化。
> - 也许你会说 `channelRegistered`,`channelUnregistered`,`channelActive`和 `channelInactive` 这几个事件也没有参数啊，为什么它们不这么照着上面的处理呢？主要是因为这几个比较特殊，它们只会调用一次，所以没有必要那么处理。

#### 查找下一个处理器上下文

1. `findContextInbound(int mask)`

```cpp
 private AbstractChannelHandlerContext findContextInbound(int mask) {
     AbstractChannelHandlerContext ctx = this;
     EventExecutor currentExecutor = executor();
     do {
         ctx = ctx.next;
         // 通过 MASK_ONLY_INBOUND 表示查找的是入站事件
         // mask 代表处理的方法，是否需要被跳过
     } while (skipContext(ctx, currentExecutor, mask, MASK_ONLY_INBOUND));
     return ctx;
 }
```

2. `findContextOutbound(int mask)`

```cpp
 private AbstractChannelHandlerContext findContextOutbound(int mask) {
     AbstractChannelHandlerContext ctx = this;
     EventExecutor currentExecutor = executor();
     do {
         ctx = ctx.prev;
         // 通过 MASK_ONLY_OUTBOUND 表示查找的是出站事件
         // mask 代表处理的方法，是否需要被跳过
     } while (skipContext(ctx, currentExecutor, mask, MASK_ONLY_OUTBOUND));
     return ctx;
 }
skipContext
```

3. `skipContext`

```java
 private static boolean skipContext(
         AbstractChannelHandlerContext ctx, EventExecutor currentExecutor, int mask, int onlyMask) {
     // Ensure we correctly handle MASK_EXCEPTION_CAUGHT which is not included in the MASK_EXCEPTION_CAUGHT
     // 这个方法返回 true，表示跳过这个 ctx，继续从管道中查找下一个。
     // 因为使用的是 || 或逻辑符，两个条件只要有一个为 true，就返回 true。
     // (ctx.executionMask & (onlyMask | mask)) == 0 表示这个 ctx 属于入站事件还是出站事件
     // (ctx.executor() == currentExecutor && (ctx.executionMask & mask) == 0)
     // 只有当 EventExecutor 相同的时候，才会考虑是否跳过 ctx，因为我们要保证事件处理的顺序。
     return (ctx.executionMask & (onlyMask | mask)) == 0 ||
             // We can only skip if the EventExecutor is the same as otherwise we need to ensure we offload
             // everything to preserve ordering.
             // See https://github.com/netty/netty/issues/10067
             (ctx.executor() == currentExecutor && (ctx.executionMask & mask) == 0);
 }
```

> 这个方法代码很简单，但是逻辑很有意思。
>
> - 方法的返回值表示是否需要跳过这个上下文 `ctx`，返回 `true` 则跳过。
> - `(ctx.executionMask & (onlyMask | mask)) == 0` ，如果等于 `true`,那就表明当前这个上下文的执行标记 `executionMask` 就没有 `(onlyMask | mask)` 中的任何方法啊，很容易就判断它不属于入站事件或者出站事件。
> - 第二个条件是判断上下文的执行标记是否包含这个方法 `ctx.executionMask & mask`，如果包含结果就不是 `1`, 不包含就是 `0` (表示跳过，返回 `true`)，所以当 `(ctx.executionMask & mask) == 0` 的时候，返回 `true`, 跳过这个上下文`ctx`，寻找下一个。
> - 不过这里多了一个 `ctx.executor() == currentExecutor` 判断, 为了事件处理的顺序性，如果事件执行器线程不一样，那么不允许跳过处理器方法，即使这个方法被 `@Skip` 注解也没用。

#### `invokeHandler`

```dart
    /**
     * 尽最大努力检测 ChannelHandler.handlerAdded(ChannelHandlerContext) 是否被调用。
     * 如果没有被调用则返回false，如果调用或无法检测返回true。
     *
     * 如果这个方法返回false，我们将不调用ChannelHandler，而只是转发事件，调用管道中下一个 ChannelHandler 处理。
     *
     * 因为可能管道DefaultChannelPipeline已经将这个 ChannelHandler放在链接列表中，
     * 但没有调用 ChannelHandler.handlerAdded(ChannelHandlerContext) 方法，
     * 有可能用户在 ChannelHandler.handlerAdded 中做了一些初始化操作，当它没有被调用时，
     * 不能将 IO 事件交个这个 ChannelHandler 处理。
     */
    private boolean invokeHandler() {
        // Store in local variable to reduce volatile reads.
        int handlerState = this.handlerState;
        return handlerState == ADD_COMPLETE || (!ordered && handlerState == ADD_PENDING);
    }
```

一般情况下，必须当上下文状态是 `ADD_COMPLETE` 才返回 `true`。

但是如果上下文的事件执行器是顺序的，那么当上下文状态是 `ADD_PENDING` 就可以返回 `true` 了。【TODO】

### WriteTask 静态内部类

#### 写操作

```dart
    /**
     * 在管道中寻找下一个事件处理器 进行写入的IO操作
     */
    @Override
    public ChannelFuture write(final Object msg, final ChannelPromise promise) {
        // 写入消息，不刷新
        write(msg, false, promise);

        return promise;
    }

    /**
     * 在管道中寻找下一个事件处理器 进行写入并刷新的IO操作
     */
    @Override
    public ChannelFuture writeAndFlush(Object msg, ChannelPromise promise) {
        // 写入消息并且刷新
        write(msg, true, promise);
        return promise;
    }
```

提供写入和写入并刷新两个方法。它们都调用了 `write(Object, boolean, ChannelPromise)` 方法。

```java
    private void write(Object msg, boolean flush, ChannelPromise promise) {
        ObjectUtil.checkNotNull(msg, "msg");
        try {
            // 检查 promise 是否有效
            if (isNotValidPromise(promise, true)) {
                // 回收引用
                ReferenceCountUtil.release(msg);
                // cancelled
                return;
            }
        } catch (RuntimeException e) {
            // 回收引用
            ReferenceCountUtil.release(msg);
            throw e;
        }

        // 通过 findContextOutbound  方法找到上一个出站处理器上下文
        final AbstractChannelHandlerContext next = findContextOutbound(flush ?
                (MASK_WRITE | MASK_FLUSH) : MASK_WRITE);
        // 只是添加附加信息，在内存泄露的时候，可以获取到这个附加信息
        final Object m = pipeline.touch(msg, next);
        EventExecutor executor = next.executor();
        if (executor.inEventLoop()) {
            // 在当前上下文线程中
            if (flush) {
                // 如果包括刷新，就调用 invokeWriteAndFlush 方法
                next.invokeWriteAndFlush(m, promise);
            } else {
                // 如果不包括刷新，就调用 invokeWrite 方法
                next.invokeWrite(m, promise);
            }
        } else {
            // 将写操作封装成一个 WriteTask，也是一个 Runnable 子类。
            final WriteTask task = WriteTask.newInstance(next, m, promise, flush);
            if (!safeExecute(executor, task, promise, m, !flush)) {
                // We failed to submit the WriteTask. We need to cancel it so we decrement the pending bytes
                // and put it back in the Recycler for re-use later.
                //
                // See https://github.com/netty/netty/issues/8343.
                task.cancel();
            }
        }
    }
```

> - 这个方法流程和之前的流程没有区别，唯一不同的就是它创建了一个 `WriteTask` 对象，而不是一个简单的 `Runnable` 实例。
> - 因为写操作比较特殊，我们需要控制等待写入数据的大小，当等待写入数据太多，那么发送 `channelWritabilityChanged` 入站`IO`事件，告诉用户当前通道不可写了，先将缓冲区数据发送到远端。
> - 如何知道等待写入数据的大小？就是通过这个 `WriteTask` 类事件，计算写入对象 `m` 的大小，累加加入到写入数据的大小中。

#### WriteTask 静态内部类

```java
 static final class WriteTask implements Runnable {
        // 使用一个对象池，复用 WriteTask 实例
        private static final ObjectPool<WriteTask> RECYCLER = ObjectPool.newPool(new ObjectCreator<WriteTask>() {
            @Override
            public WriteTask newObject(Handle<WriteTask> handle) {
                return new WriteTask(handle);
            }
        });

        // 通过静态方法得到 WriteTask 实例
        static WriteTask newInstance(AbstractChannelHandlerContext ctx,
                Object msg, ChannelPromise promise, boolean flush) {
            // 从对象池中获取 WriteTask 实例
            WriteTask task = RECYCLER.get();
            // 初始化
            init(task, ctx, msg, promise, flush);
            return task;
        }

        private static final boolean ESTIMATE_TASK_SIZE_ON_SUBMIT =
                SystemPropertyUtil.getBoolean("io.netty.transport.estimateSizeOnSubmit", true);

        // Assuming compressed oops, 12 bytes obj header, 4 ref fields and one int field
        private static final int WRITE_TASK_OVERHEAD =
                SystemPropertyUtil.getInt("io.netty.transport.writeTaskSizeOverhead", 32);

        private final Handle<WriteTask> handle;
        // 当前上下文对象
        private AbstractChannelHandlerContext ctx;
        // 写入的数据对象
        private Object msg;
        private ChannelPromise promise;
        // 写入数据的大小
        private int size; // sign bit controls flush

        @SuppressWarnings("unchecked")
        private WriteTask(Handle<? extends WriteTask> handle) {
            this.handle = (Handle<WriteTask>) handle;
        }

        protected static void init(WriteTask task, AbstractChannelHandlerContext ctx,
                                   Object msg, ChannelPromise promise, boolean flush) {
            task.ctx = ctx;
            task.msg = msg;
            task.promise = promise;

            // 是否需要估算写入数据大小
            if (ESTIMATE_TASK_SIZE_ON_SUBMIT) {
                // 估算数据大小
                task.size = ctx.pipeline.estimatorHandle().size(msg) + WRITE_TASK_OVERHEAD;
                // 增加等待写入数据的大小
                ctx.pipeline.incrementPendingOutboundBytes(task.size);
            } else {
                task.size = 0;
            }
            if (flush) {
                // 将size 大小变成负数，那么就会调用 写入并刷新的方法
                task.size |= Integer.MIN_VALUE;
            }
        }

        @Override
        public void run() {
            try {
                // 减小等待写入数据大小
                decrementPendingOutboundBytes();
                if (size >= 0) {
                    // 只调用写入操作
                    ctx.invokeWrite(msg, promise);
                } else {
                    // 当 size < 0 ,写入并刷新操作
                    ctx.invokeWriteAndFlush(msg, promise);
                }
            } finally {
                recycle();
            }
        }

        void cancel() {
            try {
                // 取消的话，也需要减小等待写入数据大小
                decrementPendingOutboundBytes();
            } finally {
                recycle();
            }
        }

        /**
         * 减小等待写入数据大小
         */
        private void decrementPendingOutboundBytes() {
            if (ESTIMATE_TASK_SIZE_ON_SUBMIT) {
                ctx.pipeline.decrementPendingOutboundBytes(size & Integer.MAX_VALUE);
            }
        }

        private void recycle() {
            // Set to null so the GC can collect them directly
            ctx = null;
            msg = null;
            promise = null;
            handle.recycle(this);
        }
    }
```

这个类的实现很简单

> - 使用静态方法从对象池中获取`WriteTask` 实例(这样会复用`WriteTask`)
> - 每次调用初始化 `init` 方法，如果配置项 `ESTIMATE_TASK_SIZE_ON_SUBMIT` 为 `true`，都会增加等待写入数据的大小。
> - 真正运行(`run`被调用)，或者取消的时候，都会减少等待写入数据的大小。

在 `DefaultChannelPipeline` 中

```csharp
    @UnstableApi
    protected void incrementPendingOutboundBytes(long size) {
        ChannelOutboundBuffer buffer = channel.unsafe().outboundBuffer();
        if (buffer != null) {
            buffer.incrementPendingOutboundBytes(size);
        }
    }

    @UnstableApi
    protected void decrementPendingOutboundBytes(long size) {
        ChannelOutboundBuffer buffer = channel.unsafe().outboundBuffer();
        if (buffer != null) {
            buffer.decrementPendingOutboundBytes(size);
        }
    }
```

> 都是调用 `ChannelOutboundBuffer` 类的对应方法。

在 `ChannelOutboundBuffer` 中

```java
    void incrementPendingOutboundBytes(long size) {
        incrementPendingOutboundBytes(size, true);
    }

    private void incrementPendingOutboundBytes(long size, boolean invokeLater) {
        if (size == 0) {
            return;
        }

        long newWriteBufferSize = TOTAL_PENDING_SIZE_UPDATER.addAndGet(this, size);
        if (newWriteBufferSize > channel.config().getWriteBufferHighWaterMark()) {
            setUnwritable(invokeLater);
        }
    }

    private void setUnwritable(boolean invokeLater) {
        for (;;) {
            final int oldValue = unwritable;
            final int newValue = oldValue | 1;
            if (UNWRITABLE_UPDATER.compareAndSet(this, oldValue, newValue)) {
                if (oldValue == 0) {
                    fireChannelWritabilityChanged(invokeLater);
                }
                break;
            }
        }
    }

    void decrementPendingOutboundBytes(long size) {
        decrementPendingOutboundBytes(size, true, true);
    }

    private void decrementPendingOutboundBytes(long size, boolean invokeLater, boolean notifyWritability) {
        if (size == 0) {
            return;
        }

        long newWriteBufferSize = TOTAL_PENDING_SIZE_UPDATER.addAndGet(this, -size);
        if (notifyWritability && newWriteBufferSize < channel.config().getWriteBufferLowWaterMark()) {
            setWritable(invokeLater);
        }
    }

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

> 在 `ChannelOutboundBuffer` 中有一个 `totalPendingSize` 变量表示写缓冲区等待数据大小。
>
> - 当它的值大于 `channel.config().getWriteBufferHighWaterMark()` 时，表示不能写了，通过 `setUnwritable(invokeLater)` 发送当前通道可写状态改变的 入站`IO`事件。
> - 当它的值小于 `channel.config().getWriteBufferLowWaterMark()` 时，表示又可以写了，通过 `setWritable(invokeLater)` 发送当前通道可写状态改变的 入站`IO`事件。

### executionMask

```Java
abstract class AbstractChannelHandlerContext implements ChannelHandlerContext, ResourceLeakHint {
	......

    private final int executionMask;

	......
    AbstractChannelHandlerContext(DefaultChannelPipeline pipeline, EventExecutor executor,
                                  String name, Class<? extends ChannelHandler> handlerClass) {
      ......
        //channelHandlerContext中保存channelHandler的执行条件掩码（是什么类型的ChannelHandler,对什么事件感兴趣）
        this.executionMask = mask(handlerClass);
        ......
    }

}
```

这里笔者重点介绍 orderd 属性和 executionMask 属性，其他的属性大家很容易理解

```java
ordered = executor == null || executor instanceof OrderedEventExecutor;
```

当我们不指定 channelHandler 的 executor 时或者指定的 executor 类型为 OrderedEventExecutor 时，ordered = true。

那么这个 ordered 属性对于 ChannelHandler 响应 pipeline 中的事件有什么影响呢？

我们之前介绍过在 ChannelHandler 响应 pipeline 中的事件之前都会调用 invokeHandler() 方法来判断是否回调 ChannelHandler 的事件回调方法还是跳过。

```java
private boolean invokeHandler() {
    int handlerState = this.handlerState;
    return handlerState == ADD_COMPLETE || (!ordered && handlerState == ADD_PENDING);
}
```

- 当 `ordered == false` 时，channelHandler 的状态为 ADD_PENDING 的时候，也可以响应 pipeline 中的事件。
- 当 `ordered == true` 时，只有在 channelHandler 的状态为 ADD_COMPLETE 的时候才能响应 pipeline 中的事件

另一个重要的属性 `executionMask` 保存的是当前 ChannelHandler 的一些执行条件信息掩码，比如：

- 当前 ChannelHandler 是什么类型的（ ChannelInboundHandler or ChannelOutboundHandler ?）。
- 当前 ChannelHandler 对哪些事件感兴趣（覆盖了哪些事件回调方法?）

```java
private static final FastThreadLocal<Map<Class<? extends ChannelHandler>, Integer>> MASKS =
    new FastThreadLocal<Map<Class<? extends ChannelHandler>, Integer>>() {
        @Override
        protected Map<Class<? extends ChannelHandler>, Integer> initialValue() {
            return new WeakHashMap<Class<? extends ChannelHandler>, Integer>(32);
        }
    };

static int mask(Class<? extends ChannelHandler> clazz) {
    // 因为每建立一个channel就会初始化一个pipeline，这里需要将ChannelHandler对应的mask缓存
    Map<Class<? extends ChannelHandler>, Integer> cache = MASKS.get();
    Integer mask = cache.get(clazz);
    if (mask == null) {
        // 计算ChannelHandler对应的mask（什么类型的ChannelHandler，对什么事件感兴趣）
        mask = mask0(clazz);
        cache.put(clazz, mask);
    }
    return mask;
}
```

这里需要一个 FastThreadLocal 类型的 MASKS 字段来缓存 ChannelHandler 对应的执行掩码。因为 ChannelHandler 类一旦被定义出来它的执行掩码就固定了，而 netty 需要接收大量的连接，创建大量的 channel ，并为这些 channel 初始化对应的 pipeline ，需要频繁的记录 channelHandler 的执行掩码到 context 类中，所以这里需要将掩码缓存起来。

```java
private static int mask0(Class<? extends ChannelHandler> handlerType) {
    int mask = MASK_EXCEPTION_CAUGHT;
    try {
        if (ChannelInboundHandler.class.isAssignableFrom(handlerType)) {
            //如果该ChannelHandler是Inbound类型的，则先将inbound事件全部设置进掩码中
            mask |= MASK_ALL_INBOUND;

            //最后在对不感兴趣的事件一一排除（handler中的事件回调方法如果标注了@Skip注解，则认为handler对该事件不感兴趣）
            if (isSkippable(handlerType, "channelRegistered", ChannelHandlerContext.class)) {
                mask &= ~MASK_CHANNEL_REGISTERED;
            }
            if (isSkippable(handlerType, "channelUnregistered", ChannelHandlerContext.class)) {
                mask &= ~MASK_CHANNEL_UNREGISTERED;
            }
            if (isSkippable(handlerType, "channelActive", ChannelHandlerContext.class)) {
                mask &= ~MASK_CHANNEL_ACTIVE;
            }
            if (isSkippable(handlerType, "channelInactive", ChannelHandlerContext.class)) {
                mask &= ~MASK_CHANNEL_INACTIVE;
            }
            if (isSkippable(handlerType, "channelRead", ChannelHandlerContext.class, Object.class)) {
                mask &= ~MASK_CHANNEL_READ;
            }
            if (isSkippable(handlerType, "channelReadComplete", ChannelHandlerContext.class)) {
                mask &= ~MASK_CHANNEL_READ_COMPLETE;
            }
            if (isSkippable(handlerType, "channelWritabilityChanged", ChannelHandlerContext.class)) {
                mask &= ~MASK_CHANNEL_WRITABILITY_CHANGED;
            }
            if (isSkippable(handlerType, "userEventTriggered", ChannelHandlerContext.class, Object.class)) {
                mask &= ~MASK_USER_EVENT_TRIGGERED;
            }
        }

        if (ChannelOutboundHandler.class.isAssignableFrom(handlerType)) {
            //如果handler为Outbound类型的，则先将全部outbound事件设置进掩码中
            mask |= MASK_ALL_OUTBOUND;

            //最后对handler不感兴趣的事件从掩码中一一排除
            if (isSkippable(handlerType, "bind", ChannelHandlerContext.class,
                    SocketAddress.class, ChannelPromise.class)) {
                mask &= ~MASK_BIND;
            }
            if (isSkippable(handlerType, "connect", ChannelHandlerContext.class, SocketAddress.class,
                    SocketAddress.class, ChannelPromise.class)) {
                mask &= ~MASK_CONNECT;
            }
            if (isSkippable(handlerType, "disconnect", ChannelHandlerContext.class, ChannelPromise.class)) {
                mask &= ~MASK_DISCONNECT;
            }
            if (isSkippable(handlerType, "close", ChannelHandlerContext.class, ChannelPromise.class)) {
                mask &= ~MASK_CLOSE;
            }
            if (isSkippable(handlerType, "deregister", ChannelHandlerContext.class, ChannelPromise.class)) {
                mask &= ~MASK_DEREGISTER;
            }
            if (isSkippable(handlerType, "read", ChannelHandlerContext.class)) {
                mask &= ~MASK_READ;
            }
            if (isSkippable(handlerType, "write", ChannelHandlerContext.class,
                    Object.class, ChannelPromise.class)) {
                mask &= ~MASK_WRITE;
            }
            if (isSkippable(handlerType, "flush", ChannelHandlerContext.class)) {
                mask &= ~MASK_FLUSH;
            }
        }

        if (isSkippable(handlerType, "exceptionCaught", ChannelHandlerContext.class, Throwable.class)) {
            mask &= ~MASK_EXCEPTION_CAUGHT;
        }
    } catch (Exception e) {
        // Should never reach here.
        PlatformDependent.throwException(e);
    }

    //计算出的掩码需要缓存，因为每次向pipeline中添加该类型的handler的时候都需要获取掩码（创建一个channel 就需要为其初始化pipeline）
    return mask;
}
```

计算 ChannelHandler 的执行掩码 mask0 方法虽然比较长，但是逻辑却十分简单。在本文的第三小节《3. pipeline 中的事件分类》中，笔者为大家详细介绍了各种事件类型的掩码表示，这里我来看下如何利用这些基本事件掩码来计算出 ChannelHandler 的执行掩码的。

如果 ChannelHandler 是 ChannelInboundHandler 类型的，那么首先会将所有 Inbound 事件掩码设置进执行掩码 mask 中。

最后挨个遍历所有 Inbound 事件，从掩码集合 mask 中排除该 ChannelHandler 不感兴趣的事件。这样一轮下来，就得到了 ChannelHandler 的执行掩码。

从这个过程中我们可以看到，ChannelHandler 的执行掩码包含的是该 ChannelHandler 感兴趣的事件掩码集合。当事件在 pipeline 中传播的时候，在 ChannelHandlerContext 中可以利用这个执行掩码来判断，当前 ChannelHandler 是否符合响应该事件的资格。

同理我们也可以计算出 ChannelOutboundHandler 类型的 ChannelHandler 对应的执行掩码。

**那么 netty 框架是如何判断出我们自定义的 ChannelHandler 对哪些事件感兴趣，对哪些事件不感兴趣的呢**?

这里我们以 ChannelInboundHandler 类型举例说明，在本文第三小节中，笔者对所有 Inbound 类型的事件作了一个全面的介绍，但是在实际开发中，我们可能并不需要监听所有的 Inbound 事件，可能只是需要监听其中的一到两个事件。

对于我们不感兴趣的事件，我们只需要在其对应的回调方法上标注 @Skip 注解即可，netty 就会认为该 ChannelHandler 对标注 @Skip 注解的事件不感兴趣，当不感兴趣的事件在 pipeline 传播的时候，该 ChannelHandler 就不需要执行响应。

```java
private static boolean isSkippable(
        final Class<?> handlerType, final String methodName, final Class<?>... paramTypes) throws Exception {
    return AccessController.doPrivileged(new PrivilegedExceptionAction<Boolean>() {
        @Override
        public Boolean run() throws Exception {
            Method m;
            try {
                // 首先查看类中是否覆盖实现了对应的事件回调方法
                m = handlerType.getMethod(methodName, paramTypes);
            } catch (NoSuchMethodException e) {
                if (logger.isDebugEnabled()) {
                    logger.debug(
                        "Class {} missing method {}, assume we can not skip execution", handlerType, methodName, e);
                }
                return false;
            }
            return m != null && m.isAnnotationPresent(Skip.class);
        }
    });
}
```

那我们在编写自定义 ChannelHandler 的时候是不是要在 ChannelInboundHandler 或者 ChannelOutboundHandler 接口提供的所有事件回调方法上，对我们不感兴趣的事件繁琐地一一标注 @Skip 注解呢？

其实是不需要的，netty 为我们提供了 ChannelInboundHandlerAdapter 类和 ChannelOutboundHandlerAdapter 类，netty 事先已经在这些 Adapter 类中的事件回调方法上全部标注了 @Skip 注解，我们在自定义实现 ChannelHandler 的时候只需要继承这些 Adapter 类并覆盖我们感兴趣的事件回调方法即可。

```java
public class ChannelInboundHandlerAdapter extends ChannelHandlerAdapter implements ChannelInboundHandler {

    @Skip
    @Override
    public void channelRegistered(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelRegistered();
    }

    @Skip
    @Override
    public void channelUnregistered(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelUnregistered();
    }

    @Skip
    @Override
    public void channelActive(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelActive();
    }

    @Skip
    @Override
    public void channelInactive(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelInactive();
    }

    @Skip
    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) throws Exception {
        ctx.fireChannelRead(msg);
    }

    @Skip
    @Override
    public void channelReadComplete(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelReadComplete();
    }

    @Skip
    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
        ctx.fireUserEventTriggered(evt);
    }

    @Skip
    @Override
    public void channelWritabilityChanged(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelWritabilityChanged();
    }

    @Skip
    @Override
    @SuppressWarnings("deprecation")
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause)
            throws Exception {
        ctx.fireExceptionCaught(cause);
    }
}
```

## HeadContext

```java
   final class HeadContext extends AbstractChannelHandlerContext
            implements ChannelOutboundHandler, ChannelInboundHandler {

        // 通道 Channel 的Unsafe
        private final Unsafe unsafe;

        HeadContext(DefaultChannelPipeline pipeline) {
            super(pipeline, null, HEAD_NAME, HeadContext.class);
            unsafe = pipeline.channel().unsafe();
            // 创建时就将自己状态变成 ADD_COMPLETE
            setAddComplete();
        }

        @Override
        public ChannelHandler handler() {
            // 事件处理器就是它自己
            return this;
        }

        @Override
        public void handlerAdded(ChannelHandlerContext ctx) {
            // NOOP
        }

        @Override
        public void handlerRemoved(ChannelHandlerContext ctx) {
            // NOOP
        }

        @Override
        public void bind(
                ChannelHandlerContext ctx, SocketAddress localAddress, ChannelPromise promise) {
            // 出站 IO 操作都是调用 unsafe 对应方法
            unsafe.bind(localAddress, promise);
        }

        @Override
        public void connect(
                ChannelHandlerContext ctx,
                SocketAddress remoteAddress, SocketAddress localAddress,
                ChannelPromise promise) {
            // 出站 IO 操作都是调用 unsafe 对应方法
            unsafe.connect(remoteAddress, localAddress, promise);
        }

        @Override
        public void disconnect(ChannelHandlerContext ctx, ChannelPromise promise) {
            // 出站 IO 操作都是调用 unsafe 对应方法
            unsafe.disconnect(promise);
        }

        @Override
        public void close(ChannelHandlerContext ctx, ChannelPromise promise) {
            // 出站 IO 操作都是调用 unsafe 对应方法
            unsafe.close(promise);
        }

        @Override
        public void deregister(ChannelHandlerContext ctx, ChannelPromise promise) {
            // 出站 IO 操作都是调用 unsafe 对应方法
            unsafe.deregister(promise);
        }

        @Override
        public void read(ChannelHandlerContext ctx) {
            // 出站 IO 操作都是调用 unsafe 对应方法
            unsafe.beginRead();
        }

        @Override
        public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) {
            // 出站 IO 操作都是调用 unsafe 对应方法
            unsafe.write(msg, promise);
        }

        @Override
        public void flush(ChannelHandlerContext ctx) {
            // 出站 IO 操作都是调用 unsafe 对应方法
            unsafe.flush();
        }

        @Override
        public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireExceptionCaught(cause);
        }

        @Override
        public void channelRegistered(ChannelHandlerContext ctx) {
            // 调用那些在未注册之前就添加的 ChannelHandler 的回调函数
            invokeHandlerAddedIfNeeded();
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireChannelRegistered();
        }

        @Override
        public void channelUnregistered(ChannelHandlerContext ctx) {
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireChannelUnregistered();

            // 如果通道关闭且未注册，则依次删除所有处理程序。
            if (!channel.isOpen()) {
                destroy();
            }
        }

        @Override
        public void channelActive(ChannelHandlerContext ctx) {
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireChannelActive();

            // 是否需要主动触发读操作
            readIfIsAutoRead();
        }

        @Override
        public void channelInactive(ChannelHandlerContext ctx) {
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireChannelInactive();
        }

        @Override
        public void channelRead(ChannelHandlerContext ctx, Object msg) {
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireChannelRead(msg);
        }

        @Override
        public void channelReadComplete(ChannelHandlerContext ctx) {
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireChannelReadComplete();

            // 是否需要主动触发读操作
            readIfIsAutoRead();
        }

        private void readIfIsAutoRead() {
            if (channel.config().isAutoRead()) {
                // 如果 isAutoRead 是true，就主动触发读操作
                channel.read();
            }
        }

        @Override
        public void userEventTriggered(ChannelHandlerContext ctx, Object evt) {
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireUserEventTriggered(evt);
        }

        @Override
        public void channelWritabilityChanged(ChannelHandlerContext ctx) {
            // 入站 IO 事件就交给 下一个入站事件处理器处理
            ctx.fireChannelWritabilityChanged();
        }
    }
```

这个类非常重要，它代表链表头的节点。

1. 它继承 `AbstractChannelHandlerContext` 类，又实现了 `ChannelOutboundHandler` 和 `ChannelInboundHandler` 接口

   > - 说明它即是一个上下文对象，又是一个事件处理器，该上下文对应的事件处理器就是它自己。
   > - 它既可以处理入站事件，又可以处理出站事件。

2. 处理 `IO` 事件

   > - 因为管道中 `IO` 事件的流向是，入站事件是从头到尾，出站事件是从尾到头。
   > - 对于入站事件，就直接调用 `ChannelHandlerContext` 对应方法，将入站事件交给 下一个入站事件处理器处理。
   > - 对于出站事件，因为已经是链表头，是最后处理出站事件的地方，所以调用 `Unsafe` 的对应方法处理。也就是说所有出站事件的最后归宿应该都是调用 `Unsafe` 方法处理。

## TailContext

```java
    final class TailContext extends AbstractChannelHandlerContext implements ChannelInboundHandler {

        TailContext(DefaultChannelPipeline pipeline) {
            super(pipeline, null, TAIL_NAME, TailContext.class);
            // 创建时就将自己状态变成 ADD_COMPLETE
            setAddComplete();
        }

        @Override
        public ChannelHandler handler() {
            // 事件处理器就是它自己
            return this;
        }

        @Override
        public void channelRegistered(ChannelHandlerContext ctx) { }

        @Override
        public void channelUnregistered(ChannelHandlerContext ctx) { }

        @Override
        public void channelActive(ChannelHandlerContext ctx) {
            onUnhandledInboundChannelActive();
        }

        @Override
        public void channelInactive(ChannelHandlerContext ctx) {
            onUnhandledInboundChannelInactive();
        }

        @Override
        public void channelWritabilityChanged(ChannelHandlerContext ctx) {
            onUnhandledChannelWritabilityChanged();
        }

        @Override
        public void handlerAdded(ChannelHandlerContext ctx) { }

        @Override
        public void handlerRemoved(ChannelHandlerContext ctx) { }

        @Override
        public void userEventTriggered(ChannelHandlerContext ctx, Object evt) {
            onUnhandledInboundUserEventTriggered(evt);
        }

        @Override
        public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
            onUnhandledInboundException(cause);
        }

        @Override
        public void channelRead(ChannelHandlerContext ctx, Object msg) {
            onUnhandledInboundMessage(ctx, msg);
        }

        @Override
        public void channelReadComplete(ChannelHandlerContext ctx) {
            onUnhandledInboundChannelReadComplete();
        }
    }
```

> - `TailContext`继承 `AbstractChannelHandlerContext` 类，又实现了`ChannelInboundHandler` 接口, 表明它即是一个上下文对象，又是一个入站事件处理器，该上下文对应的事件处理器就是它自己。

`TailContext`的作用很简单，它是最后处理入站事件的地方

> 也就是说入站事件在链表中，没有任何入站处理器处理，那么 `TailContext` 就要做一些收尾的处理。比如说捕获异常，一些资源的回收等等。

在 TailContext 中需要对这些得不到任何处理的 inbound 事件做出最终处理。比如丢弃该 msg，并释放所占用的 directByteBuffer，以免发生内存泄露。

```java
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
        ReferenceCountUtil.release(msg);
    }
}
```
