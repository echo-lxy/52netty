# 核心引擎 Reactor 的运转架构

## 前置知识

现在启动引导层的逻辑我们分析的大差不差了，现在请你预想一下接下来逻辑会带领着我们走到哪儿？

在[《BootStrap 启动 Netty 服务》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_run)末尾，BootStrap 引导类已经结束它的核心工作了，它最后的任务就是绑定端口

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730010442393-ee7e533d-aa53-4755-92c5-859139064362.png)

接着就开始等待 Main Reactor 上唯一的这个 `NioServerSocketChannel` 关闭：`f.channel().closeFuture().sync();`

所以我们的主线程就被卡在这儿了，那接下来我们程序的触发器是什么呢

不知你是否还记得 Netty 官网上的这段大字？

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730010818152-7a66884e-a6c8-49aa-8b13-12a0de9f9f1d.png)

::: info 翻译

Netty 是一个异步事件驱动的网络应用程序框架，用于快速开发可维护的高性能协议服务器和客户端。

:::

因此得知 Netty 是依靠事件去 **触发** 其核心服务的，那么

* 这些事件是什么呢？
* Reactor 线程又是如何去**被**事件所驱动的呢？

这就是本文的目标

在[《BootStrap 启动 Netty 服务》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_run)中，我们最终创建出了如下 **Main Sub Reactor Group 模型**

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311546798.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

- **Main Reactor Group** 管理着 `NioServerSocketChannel`，用于接收客户端连接。在其 pipeline 中的 `ServerBootstrapAcceptor` 里初始化接收到的客户端连接，随后将初始化好的客户端连接注册到从 Reactor 线程组中。
- **Sub Reactor Group** 主要负责监听和处理注册到其上的所有 `NioSocketChannel` 的 IO 就绪事件。
  - 一个 Channel 只能分配给一个固定的 Reactor。
  - 一个 Reactor 负责处理多个 Channel 上的 IO 就绪事件，这样可以将服务端承载的全量客户端连接分摊到多个 Reactor 中处理，同时也能保证 Channel 上 IO 处理的线程安全性。


Reactor 与 Channel 之间的对应关系如下图所示：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311607161.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,b_nw,x_1,y_1" alt="image-20241031160743074" style="zoom:33%;" />

------

当 Netty Reactor 框架启动完毕后，第一件也是最重要的事情就是高效地接收客户端的连接。在探讨 Netty 服务端如何接收连接之前，我们需要弄清楚 Reactor 线程的运行机制，以及它是如何监听并处理 Channel 上的 IO 就绪事件的。

本文相当于后续我们介绍 Reactor 线程监听处理 Connect 事件、ACCEPT 事件、Read 事件和 Write 事件的前置篇，专注于讲述 Reactor 线程的整个运行框架。理解本文内容将对理解后面 Reactor 线程如何处理 IO 事件大有帮助。

在 Netty 框架的创建和启动阶段，我们无数次提到 Reactor 线程。在本文要介绍的运行阶段，Reactor 线程将大显神威。

经过前面的介绍，我们了解到 **Netty 中的 Reactor 线程主要完成以下三件事情**：

- 轮询注册在 Reactor 上的所有 Channel 感兴趣的 IO 就绪事件
- 处理 Channel 上的 IO 就绪事件
- 执行 Reactor 中的异步任务

## Reactor 线程的整个运行框架

- Netty 的 IO 模型是通过 JDK NIO Selector 实现的 IO 多路复用模型
- Netty 的 IO 线程模型为主从 Reactor 线程模型

因此，我们很容易理解 Netty 会使用一个用户态的 Reactor 线程，不断通过 Selector 在内核态轮询 Channel 上的 IO 就绪事件。简单来说，Reactor 线程实际上执行的是一个死循环，在这个循环中不断通过 Selector 轮询 IO 就绪事件：

* 如果发生 IO 就绪事件，则从 Selector 系统调用中返回并处理相应的事件
* 如果没有发生 IO 就绪事件，则一直阻塞在 Selector 系统调用上，直到满足 Selector 的唤醒条件。

**那唤醒条件是啥呢？** 

以下三个条件中，只要满足任意一个，Reactor 线程就会从 Selector 上被唤醒：

- 当 Selector 轮询到有 IO 活跃事件发生时。
- 当 Reactor 线程需要执行的定时任务到达任务执行时间（deadline）时。
- 当有异步任务提交给 Reactor 时，Reactor 线程需要从 Selector 上被唤醒，以便及时执行异步任务。

 可以看出，Netty 对 Reactor 线程的利用相当高效。如果当前没有 IO 就绪事件需要处理，Reactor 线程不会在此闲等待，而是会立即被唤醒，转而处理提交的异步任务和定时任务。因此，Reactor 线程可以说是 996 的典范，一刻不停歇地运作着。  

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311608510.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031160816422" style="zoom:33%;" />

 在了解了 Reactor 线程的大概运行框架后，接下来我们将深入源码，查看其核心运转框架的实现。由于这部分源码较为庞大和复杂，笔者将先提取出其运行框架，以便于大家整体理解整个运行过程的全貌。  

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410312247735.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031163518703" style="zoom: 33%;" />

上图所展示的就是 **Reactor** 整个工作体系的全貌，主要分为如下几个重要的工作模块：

1. **Reactor线程** 在 `Selector` 上阻塞获取 IO 就绪事件。在这个模块中，首先会检查当前是否有异步任务需要执行。如果有异步任务，那么无论当前是否有 IO 就绪事件，都不能阻塞在 `Selector` 上。随后，会非阻塞地轮询 `Selector` 上是否有 IO 就绪事件。如果有，则可以与异步任务一起执行，优先处理 IO 就绪事件，再执行异步任务。
2. 如果当前没有异步任务需要执行，**Reactor线程** 会接着查看是否有定时任务需要执行。如果有，则在 `Selector` 上阻塞，直到定时任务的到期时间 `deadline`，或满足其他唤醒条件被唤醒。如果没有定时任务需要执行，**Reactor线程** 则会在 `Selector` 上一直阻塞，直到满足唤醒条件。
3. 当 **Reactor线程** 满足唤醒条件被唤醒后，首先会判断当前是因为有 IO 就绪事件被唤醒，还是因为有异步任务需要执行被唤醒，或是两者都有。随后，**Reactor线程** 就会处理 IO 就绪事件并执行异步任务。
4. 最后，**Reactor线程** 返回循环起点，不断重复上述三个步骤。



以上就是 **Reactor线程** 运行的整个核心逻辑。下面是笔者根据上述核心逻辑，将 **Reactor** 的整体代码设计框架提取出来。大家可以结合上面的 **Reactor** 工作流程图，从总体上先感受一下整个源码实现框架。

```java
@Override
protected void run() {
    // 记录轮询次数，用于解决 JDK epoll 的空轮询 bug
    int selectCnt = 0;
    for (;;) {
        try {
            // 轮询结果
            int strategy;
            try {
                // 根据轮询策略获取轮询结果
                // 这里的 hasTasks() 主要检查的是普通队列和尾部队列中是否有异步任务等待执行
                strategy = selectStrategy.calculateStrategy(selectNowSupplier, hasTasks());
                switch (strategy) {
                    case SelectStrategy.CONTINUE:
                        continue;

                    case SelectStrategy.BUSY_WAIT:
                        // NIO 不支持自旋（BUSY_WAIT）

                    case SelectStrategy.SELECT:
                        // 核心逻辑是有任务需要执行，则 Reactor 线程立马执行异步任务，
                        // 如果没有异步任务执行，则进行轮询 IO 事件
                        break; // 需要添加 break; 以结束 switch 语句

                    default:
                        // 处理其他策略
                        break;
                }
            } catch (IOException e) {
                // 处理异常，省略
            }

            // 执行到这里说明满足了唤醒条件，Reactor 线程从 selector 上被唤醒
            // 开始处理 IO 就绪事件和执行异步任务
            /**
             * Reactor 线程需要保证及时的执行异步任务，
             * 只要有异步任务提交，就需要退出轮询。
             * 有 IO 事件就优先处理 IO 事件，然后处理异步任务
             */

            selectCnt++;
            // 主要用于从 IO 就绪的 SelectedKeys 集合中剔除已经失效的 selectKey
            needsToSelectAgain = false;

            // 调整 Reactor 线程执行 IO 事件和执行异步任务的 CPU 时间比例
            // 默认 50，表示执行 IO 事件和异步任务的时间比例是一比一
            final int ioRatio = this.ioRatio;

            // 这里主要处理 IO 就绪事件，以及执行异步任务
            // 需要优先处理 IO 就绪事件，然后根据 ioRatio 设置的处理 IO 事件 CPU 用时与异步任务 CPU 用时比例，
            // 来决定执行多长时间的异步任务

            // 判断是否触发 JDK Epoll BUG 触发空轮询
            if (ranTasks || strategy > 0) {
                if (selectCnt > MIN_PREMATURE_SELECTOR_RETURNS && logger.isDebugEnabled()) {
                    logger.debug("Selector.select() returned prematurely {} times in a row for Selector {}.",
                                 selectCnt - 1, selector);
                }
                selectCnt = 0;
            } else if (unexpectedSelectorWakeup(selectCnt) ) { // Unexpected wakeup (unusual case)
                // 既没有 IO 就绪事件，也没有异步任务，Reactor 线程从 Selector 上被异常唤醒
                // 触发 JDK Epoll 空轮询 BUG，重新构建 Selector, selectCnt 归零
                selectCnt = 0;
            }
        } catch (CancelledKeyException e) {
            // 处理异常，省略
        } catch (Error e) {
            // 处理异常，省略
        } catch (Throwable t) {
            // 处理异常，省略
        } finally {
            // 清理资源，省略
        }
    }
}

```



从上述提取出的 Reactor 源码实现框架中，我们可以看出 Reactor 线程主要完成以下几个任务：

1. **轮询 IO 事件**：通过 JDK NIO Selector 轮询注册在 Reactor 上的所有 Channel 感兴趣的 IO 事件。对于 `NioServerSocketChannel`，由于它主要负责接收客户端连接，因此监听的是 `OP_ACCEPT` 事件。对于客户端的 `NioSocketChannel`，它主要处理连接上的读写事件，监听的是 `OP_READ` 和 `OP_WRITE` 事件。
2. **执行异步任务**：如果有异步任务需要执行，Reactor 线程会立即停止轮询操作，转而执行异步任务。这里分为两种情况：
   - **同时有 IO 就绪事件和异步任务**：优先处理 IO 就绪事件，然后根据 `ioRatio` 设置的执行时间比例决定执行多长时间的异步任务。Reactor 线程需要控制异步任务的执行时间，因为其核心任务是处理 IO 就绪事件，不能因为异步任务的执行而耽误最重要的事情。
   - **没有 IO 就绪事件，但有异步或定时任务**：只执行异步任务，尽可能地压榨 Reactor 线程，确保在没有 IO 就绪事件发生时也不闲着。


3. **判断唤醒原因**：最后，Netty 会判断本次 Reactor 线程的唤醒是否由于触发了 JDK epoll 空轮询 BUG。如果触发了该 BUG，则重建 Selector，以绕过 JDK 的 BUG，达到解决问题的目的。

## 1、Reactor 线程轮询 IO 就绪事件

```java
public NioEventLoopGroup(
        int nThreads, Executor executor, final SelectorProvider selectorProvider) {
    this(nThreads, executor, selectorProvider, DefaultSelectStrategyFactory.INSTANCE);
}

public NioEventLoopGroup(int nThreads, Executor executor, final SelectorProvider selectorProvider,
                         final SelectStrategyFactory selectStrategyFactory) {
    super(nThreads, executor, selectorProvider, selectStrategyFactory, RejectedExecutionHandlers.reject());
}
```

Reactor 线程最重要的一件事情就是轮询 IO 就绪事件。`SelectStrategyFactory` 是用于指定轮询策略的，其默认实现为 `DefaultSelectStrategyFactory.INSTANCE`。

在 Reactor 线程开启轮询之初，会使用该 `selectStrategy` 计算一个轮询策略 `strategy`，后续将根据这个 `strategy` 进行不同的逻辑处理。

接下来，我们来看看这个轮询策略 `strategy` 具体的计算逻辑是什么样的。

### 轮询策略

 从默认的轮询策略中，我们可以看出 `selectStrategy.calculateStrategy` 只会返回三种情况：  

![image-20241030154859578](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301556604.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

```java
public interface SelectStrategy {

    /**
     * Indicates a blocking select should follow.
     */
    int SELECT = -1;
    /**
     * Indicates the IO loop should be retried, no blocking select to follow directly.
     */
    int CONTINUE = -2;
    /**
     * Indicates the IO loop to poll for new events without blocking.
     */
    int BUSY_WAIT = -3;

    int calculateStrategy(IntSupplier selectSupplier, boolean hasTasks) throws Exception;
}
```

我们首先来看一下 Netty 中定义的三种轮询策略：

- **SelectStrategy.SELECT**：当没有任何异步任务需要执行时，Reactor 线程可以安心地阻塞在 Selector 上，等待 IO 就绪事件的到来。
- **SelectStrategy.CONTINUE**：重新开启一轮 IO 轮询。
- **SelectStrategy.BUSY_WAIT**：Reactor 线程进行自旋轮询。由于 NIO 不支持自旋操作，因此这里直接跳转到 `SelectStrategy.SELECT` 策略。

接下来，我们来看轮询策略的计算逻辑 `calculateStrategy`。

```java
final class DefaultSelectStrategy implements SelectStrategy {
    static final SelectStrategy INSTANCE = new DefaultSelectStrategy();

    private DefaultSelectStrategy() { }

    @Override
    public int calculateStrategy(IntSupplier selectSupplier, boolean hasTasks) throws Exception {
        /**
         * Reactor线程要保证及时的执行异步任务
         * 1：如果有异步任务等待执行，则马上执行selectNow()非阻塞轮询一次IO就绪事件
         * 2：没有异步任务，则跳到switch select分支
         * */
        return hasTasks ? selectSupplier.get() : SelectStrategy.SELECT;
    }
}
```

在 Reactor 线程的轮询工作开始之前，需要首先判断当前是否有异步任务需要执行。判断依据是查看 Reactor 中的异步任务队列 `taskQueue` 以及用于统计信息的尾部队列 `tailTask` 是否存在异步任务。

如果这两个队列中有任务待处理，Reactor 线程将相应地调整其轮询策略，以确保及时执行这些任务。

```java
@Override
protected boolean hasTasks() {
    return super.hasTasks() || !tailTasks.isEmpty();
}

protected boolean hasTasks() {
    assert inEventLoop();
    return !taskQueue.isEmpty();
}
```

如果 Reactor 中有异步任务需要执行，Reactor 线程将立即执行这些任务，不能在 Selector 上阻塞。在返回之前，线程会调用 `selectNow()` 进行非阻塞检查，以查看当前是否有 IO 就绪事件发生。如果有 IO 就绪事件，则可以与异步任务一起处理；如果没有，则及时处理异步任务，确保高效地利用线程资源。

::: tip Netty 在这里要表达的语义是

* 首先，Reactor 线程需要优先保证 IO 就绪事件的处理，其次是确保异步任务的及时执行。
* 如果当前没有 IO 就绪事件，但存在异步任务需要执行，Reactor 线程应及时执行这些异步任务，而不是继续在 Selector 上阻塞等待 IO 就绪事件。这样可以提高系统的响应速度和整体效率。

:::

```java
private final IntSupplier selectNowSupplier = new IntSupplier() {
    @Override
    public int get() throws Exception {
        return selectNow();
    }
};

int selectNow() throws IOException {
    //非阻塞
    return selector.selectNow();
}
```

如果当前 Reactor 线程没有异步任务需要执行，则 `calculateStrategy` 方法将直接返回 `SelectStrategy.SELECT`，即 `SelectStrategy` 接口中定义的常量 `-1`。

当 `calculateStrategy` 方法通过 `selectNow()` 返回非零数值时，表示此时有 IO 就绪的 Channel，返回的数值则表示有多少个 IO 就绪的 Channel。这一机制确保了在处理 IO 就绪事件时能够及时响应并进行有效的处理。



 从默认的轮询策略中，我们可以看出 `selectStrategy.calculateStrategy` 只会返回三种情况：  

![image-20241030151501580](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301520999.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)



- **返回 -1**：此时 `switch` 逻辑分支进入 `SelectStrategy.SELECT` 分支，表示 Reactor 中没有异步任务需要执行，Reactor 线程可以安心地阻塞在 Selector 上，等待 IO 就绪事件的发生。
- **返回 0**：此时 `switch` 逻辑分支进入 `default` 分支，表示 Reactor 中没有 IO 就绪事件，但有异步任务需要执行，流程通过 `default` 分支直接进入处理异步任务的逻辑部分。
- **返回 > 0**：此时 `switch` 逻辑分支同样进入 `default` 分支，表示 Reactor 中既有 IO 就绪事件发生，也有异步任务需要执行，流程通过 `default` 分支直接进入处理 IO 就绪事件和执行异步任务的逻辑部分。



现在`Reactor`的流程处理逻辑走向我们清楚了，那么接下来我们把重点放在`SelectStrategy.SELECT`分支中的轮询逻辑上。

**这块是 Reactor 监听 IO 就绪事件的核心。**



### 轮询逻辑

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311613278.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031161354101" style="zoom:33%;" />

```java
case SelectStrategy.SELECT:
    //当前没有异步任务执行，Reactor线程可以放心的阻塞等待IO就绪事件
    //从定时任务队列中取出即将快要执行的定时任务deadline
    long curDeadlineNanos = nextScheduledTaskDeadlineNanos();
    if (curDeadlineNanos == -1L) {
        // -1代表当前定时任务队列中没有定时任务
        curDeadlineNanos = NONE; // nothing on the calendar
    }

    //最早执行定时任务的deadline作为 select的阻塞时间，意思是到了定时任务的执行时间
    //不管有无IO就绪事件，必须唤醒selector，从而使reactor线程执行定时任务
    nextWakeupNanos.set(curDeadlineNanos);
    try {
        if (!hasTasks()) {
            //再次检查普通任务队列中是否有异步任务
            //没有的话开始select阻塞轮询IO就绪事件
            strategy = select(curDeadlineNanos);
        }
    } finally {
        // 执行到这里说明Reactor已经从Selector上被唤醒了
        // 设置Reactor的状态为苏醒状态AWAKE
        // lazySet优化不必要的volatile操作，不使用内存屏障，不保证写操作的可见性（单线程不需要保证）
        nextWakeupNanos.lazySet(AWAKE);
    }
```

流程走到这里，说明当前 Reactor 上没有任何事情可做，可以安心地阻塞在 Selector 上，等待 IO 就绪事件的到来。

**那么，Reactor 线程到底应该在 Selector 上阻塞多久呢？**

Reactor 线程除了要轮询 Channel 上的 IO 就绪事件以及处理这些事件外，还有一个任务，就是负责执行 Netty 框架中的异步任务。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311612707.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031161203653" style="zoom:33%;" />

在 Netty 框架中，异步任务分为三类：

- **普通异步任务**：存放在普通任务队列 `taskQueue` 中。
- **尾部任务**：存放在尾部队列 `tailTasks` 中，用于执行统计任务等收尾动作。
- **定时任务**：存放在 Reactor 中的定时任务队列 `scheduledTaskQueue` 中。

从 `ReactorNioEventLoop` 类的继承结构中，我们也可以看出，Reactor 具备执行定时任务的能力。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301406902.png" alt="image-20241030140617834" style="zoom: 67%;" />

**既然 Reactor 需要执行定时任务，它就不能一直阻塞在 Selector 上无限等待 IO 就绪事件。**

为了保证 Reactor 能够及时地执行定时任务，Reactor 线程需要在即将要执行的第一个定时任务的截止时间（deadline）到达之前被唤醒。因此，**在 Reactor 线程开始轮询 IO 就绪事件之前，我们需要首先计算出 Reactor 线程在 Selector 上的阻塞超时时间**。

#### Reactor 的轮询超时时间

 首先，我们需要从 Reactor 的定时任务队列 `scheduledTaskQueue` 中取出即将要执行的定时任务的截止时间（deadline）。将这个 deadline 作为 Reactor 线程在 Selector 上轮询的超时时间。这样可以确保在定时任务即将要执行时，Reactor 能够及时地从 Selector 上被唤醒。  

```java
private static final long AWAKE = -1L;
private static final long NONE = Long.MAX_VALUE;

// nextWakeupNanos is:
//    AWAKE            when EL is awake
//    NONE             when EL is waiting with no wakeup scheduled
//    other value T    when EL is waiting with wakeup scheduled at time T
private final AtomicLong nextWakeupNanos = new AtomicLong(AWAKE);

long curDeadlineNanos = nextScheduledTaskDeadlineNanos();
if (curDeadlineNanos == -1L) {
    // -1代表当前定时任务队列中没有定时任务
    curDeadlineNanos = NONE; // nothing on the calendar
}

nextWakeupNanos.set(curDeadlineNanos);
public abstract class AbstractScheduledEventExecutor extends AbstractEventExecutor {

    PriorityQueue<ScheduledFutureTask<?>> scheduledTaskQueue;

    protected final long nextScheduledTaskDeadlineNanos() {
        ScheduledFutureTask<?> scheduledTask = peekScheduledTask();
        return scheduledTask != null ? scheduledTask.deadlineNanos() : -1;
    }

    final ScheduledFutureTask<?> peekScheduledTask() {
        Queue<ScheduledFutureTask<?>> scheduledTaskQueue = this.scheduledTaskQueue;
        return scheduledTaskQueue != null ? scheduledTaskQueue.peek() : null;
    }

}
```

`nextScheduledTaskDeadlineNanos` 方法会返回当前 Reactor 定时任务队列中最近的一个定时任务的截止时间（deadline），如果定时任务队列中没有定时任务，则返回 -1。

在 `NioEventLoop` 中，`nextWakeupNanos` 变量用来存放 Reactor 从 Selector 上被唤醒的时间点。它被设置为最近需要被执行的定时任务的 deadline。如果当前并没有定时任务需要执行，那么 `nextWakeupNanos` 将被设置为 `Long.MAX_VALUE`，以便一直阻塞，直到有 IO 就绪事件到达或者有异步任务需要执行。

#### Reactor 开始轮询 IO 就绪事件

```java
if (!hasTasks()) {
     //再次检查普通任务队列中是否有异步任务， 没有的话就开始select阻塞轮询IO就绪事件
    strategy = select(curDeadlineNanos);
}
```

在 Reactor 线程开始阻塞轮询 IO 就绪事件之前，还需要再次检查是否有异步任务需要执行。如果此时恰好有异步任务被提交，就需要停止 IO 就绪事件的轮询，转而执行这些异步任务。如果没有异步任务，则正式开始轮询 IO 就绪事件。  

```java
private int select(long deadlineNanos) throws IOException {
    if (deadlineNanos == NONE) {
        //无定时任务，无普通任务执行时，开始轮询IO就绪事件，没有就一直阻塞 直到唤醒条件成立
        return selector.select();
    }

    long timeoutMillis = deadlineToDelayNanos(deadlineNanos + 995000L) / 1000000L;

    return timeoutMillis <= 0 ? selector.selectNow() : selector.select(timeoutMillis);
}
```

如果 `deadlineNanos == NONE`，经过上小节的介绍，我们知道 `NONE` 表示当前 Reactor 中并没有定时任务，因此可以安心地阻塞在 Selector 上，等待 IO 就绪事件的到来。

`selector.select()` 是一个阻塞调用，如果没有 IO 就绪事件，Reactor 线程将会一直阻塞在这里，直到 IO 就绪事件到来。

::: danger 问题来了！

此时 Reactor 线程正阻塞在 `selector.select()` 调用上，等待 IO 就绪事件的到来。如果此时恰好有异步任务被提交到 Reactor 中需要执行，并且此时没有任何 IO 就绪事件，Reactor 线程由于没有 IO 就绪事件到来，会继续在这里阻塞，那么如何去执行异步任务呢？

:::

解铃还须系铃人，既然异步任务在被提交后希望立刻得到执行，那么在提交异步任务的时候就需要唤醒 Reactor 线程。

```java
//addTaskWakesUp = true 表示 当且仅当只有调用addTask方法时 才会唤醒Reactor线程
//addTaskWakesUp = false 表示 并不是只有addTask方法才能唤醒Reactor 还有其他方法可以唤醒Reactor 默认设置false
private final boolean addTaskWakesUp;

private void execute(Runnable task, boolean immediate) {
    boolean inEventLoop = inEventLoop();
    addTask(task);
    if (!inEventLoop) {
        //如果当前线程不是Reactor线程，则启动Reactor线程
        //这里可以看出Reactor线程的启动是通过 向NioEventLoop添加异步任务时启动的
        startThread();
        .....................省略...................
    }

    if (!addTaskWakesUp && immediate) {
        //io.netty.channel.nio.NioEventLoop.wakeup
        wakeup(inEventLoop);
    }
}
```

对于 `execute` 方法，大家一定不会陌生，我们在介绍 Reactor 线程的启动时提到过该方法。在启动过程中，涉及到的重要操作如 Register 操作和 Bind 操作都需要封装成异步任务，通过该方法提交到 Reactor 中执行。

这里我们将重点放在 `execute` 方法后半段的唤醒逻辑部分。首先介绍与唤醒逻辑相关的两个参数：

- **immediate**：表示提交的任务是否需要被立即执行。在 Netty 中，只要你提交的任务类型不是 `LazyRunnable` 类型的任务，都是需要立即执行的，此时 `immediate = true`。
- **addTaskWakesUp**：`true` 表示当且仅当只有调用 `addTask` 方法时才会唤醒 Reactor 线程。调用其他方法并不会唤醒 Reactor 线程。在初始化 `NioEventLoop` 时，该参数会设置为 `false`，表示不仅只有 `addTask` 方法可以唤醒 Reactor 线程，还有其他方法可以唤醒，比如这里的 `execute` 方法。

针对 `execute` 方法中的唤醒条件 `!addTaskWakesUp && immediate`，Netty 这里要表达的语义是：当 `immediate` 参数为 `true` 时，表示该异步任务需要立即执行，而 `addTaskWakesUp` 默认设置为 `false`，表示不仅 `addTask` 方法可以唤醒 Reactor，其他方法如 `execute` 也可以唤醒。然而，当将 `addTaskWakesUp` 设置为 `true` 时，语义就变为只有 `addTask` 才可以唤醒 Reactor，即使 `execute` 方法里的 `immediate = true` 也不能唤醒 Reactor，因为执行的是 `execute` 方法而不是 `addTask` 方法。

```java
private static final long AWAKE = -1L;
private final AtomicLong nextWakeupNanos = new AtomicLong(AWAKE);

protected void wakeup(boolean inEventLoop) {
    if (!inEventLoop && nextWakeupNanos.getAndSet(AWAKE) != AWAKE) {
        //将Reactor线程从Selector上唤醒
        selector.wakeup();
    }
}
```

当 `nextWakeupNanos = AWAKE` 时，表示当前 Reactor 正处于苏醒状态。既然处于苏醒状态，就没有必要再次执行 `selector.wakeup()` 来重复唤醒 Reactor，这样可以省去这一次的系统调用开销。

在本文[《轮询逻辑》](/netty_source_code_parsing/main_task/event_scheduling_layer/reactor_dispatch.html#%E8%BD%AE%E8%AF%A2%E9%80%BB%E8%BE%91)小结开始介绍的源码实现框架中，当 Reactor 被唤醒后，执行的代码会进入 `finally {...}` 语句块，在那里会将 `nextWakeupNanos` 设置为 `AWAKE`。

```java
try {
    if (!hasTasks()) {
        strategy = select(curDeadlineNanos);
    }
} finally {
    // 执行到这里说明Reactor已经从Selector上被唤醒了
    // 设置Reactor的状态为苏醒状态AWAKE
    // lazySet优化不必要的volatile操作，不使用内存屏障，不保证写操作的可见性（单线程不需要保证）
    nextWakeupNanos.lazySet(AWAKE);
}
```

这里 Netty 使用了一个 `AtomicLong` 类型的变量 `nextWakeupNanos`，既能表示当前 Reactor 线程的状态，又能表示 Reactor 线程的阻塞超时时间。这种设计方式不仅提高了状态管理的效率，还减少了所需的变量数量。在日常开发中，我们也可以借鉴这种技巧，以实现更简洁且高效的代码。  

------

我们继续回到`Reactor线程`轮询`IO就绪事件`的主线上。

```java
private int select(long deadlineNanos) throws IOException {
    if (deadlineNanos == NONE) {
        //无定时任务，无普通任务执行时，开始轮询IO就绪事件，没有就一直阻塞 直到唤醒条件成立
        return selector.select();
    }

    long timeoutMillis = deadlineToDelayNanos(deadlineNanos + 995000L) / 1000000L;

    return timeoutMillis <= 0 ? selector.selectNow() : selector.select(timeoutMillis);
}
```

当 `deadlineNanos` 不为 `NONE` 时，表示此时 Reactor 有定时任务需要执行，Reactor 线程需要阻塞在 Selector 上，等待 IO 就绪事件，直到最近的一个定时任务执行时间点 deadline 到达。

这里的 `deadlineNanos` 表示的是 Reactor 中最近的一个定时任务执行时间点，单位是纳秒，指的是一个绝对时间。而我们需要计算的是 Reactor 线程阻塞在 Selector 的超时时间 `timeoutMillis`，单位是毫秒，指的是一个相对时间。

![image-20241030154146422](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301541468.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

所以，在 Reactor 线程开始阻塞在 Selector 之前，我们需要将单位为纳秒的绝对时间 `deadlineNanos` 转化为单位为毫秒的相对时间 `timeoutMillis`。

这里大家可能会好奇，为什么在通过 `deadlineToDelayNanos` 方法计算 `timeoutMillis` 时，要给 `deadlineNanos` 加上 `0.995` 毫秒呢？

想象一下这样的场景：当最近的一个定时任务的 `deadline` 即将在 5 微秒内到达时，将纳秒转换成毫秒计算出的 `timeoutMillis` 会是 0。在 Netty 中，`timeoutMillis = 0` 要表达的语义是：定时任务执行时间已经到达 `deadline` 时间点，需要被执行。然而，现实情况是定时任务还有 5 微秒才能到达 `deadline`。

因此，为了避免这种情况，需要在 `deadlineNanos` 加上 `0.995` 毫秒，以确保转换后的 `timeoutMillis` 至少为 1 毫秒，从而不会让其为 0。

所以从这里我们可以看出，`Reactor`在有定时任务的情况下，`至少要阻塞1毫秒`。

```java
public abstract class AbstractScheduledEventExecutor extends AbstractEventExecutor {

    protected static long deadlineToDelayNanos(long deadlineNanos) {
        return ScheduledFutureTask.deadlineToDelayNanos(deadlineNanos);
    }
}
final class ScheduledFutureTask<V> extends PromiseTask<V> implements ScheduledFuture<V>, PriorityQueueNode {

    static long deadlineToDelayNanos(long deadlineNanos) {
        return deadlineNanos == 0L ? 0L : Math.max(0L, deadlineNanos - nanoTime());
    }

    //启动时间点
    private static final long START_TIME = System.nanoTime();

    static long nanoTime() {
        return System.nanoTime() - START_TIME;
    }

    static long deadlineNanos(long delay) {
        //计算定时任务执行deadline  去除启动时间
        long deadlineNanos = nanoTime() + delay;
        // Guard against overflow
        return deadlineNanos < 0 ? Long.MAX_VALUE : deadlineNanos;
    }

}
```

这里需要注意的是，在创建定时任务时，会通过 `deadlineNanos` 方法计算定时任务的执行 `deadline`，其计算逻辑为：
$$
\text{deadlineNanos} = \text{当前时间点} + \text{任务延时 delay} - \text{系统启动时间}
$$
因此，在计算 `deadline` 时需要扣除系统启动的时间。

所以，在通过 `deadline` 计算延时 `delay`（也就是 `timeout`）的时候，需要加上系统启动的时间：`deadlineNanos - nanoTime()`

* 当通过 `deadlineToDelayNanos` 计算出的 `timeoutMillis` <= 0 时，表示 Reactor 目前有临近的定时任务需要执行，这时就需要立马返回，不能阻塞在 Selector 上影响定时任务的执行。当然，在返回执行定时任务之前，需要非阻塞地通过 `selector.selectNow()` 轮询一下 Channel 上是否有 IO 就绪事件到达，以防耽误 IO 事件的处理。真是操碎了心！

* 当 `timeoutMillis` > 0 时，Reactor 线程就可以安心地阻塞在 Selector 上等待 IO 事件的到来，直到 `timeoutMillis` 超时时间到达：

```java
timeoutMillis <= 0 ? selector.selectNow() : selector.select(timeoutMillis)
```

当注册在 Reactor 上的 Channel 中有 IO 事件到来时，Reactor 线程就会从 `selector.select(timeoutMillis)` 调用中被唤醒，立即去处理 IO 就绪事件。

::: warning 这里假设一种极端情况

如果最近的一个定时任务的 `deadline` 在未来很远的时间点，这样就会使 `timeoutMillis` 的时间非常非常久，那么 Reactor 岂不是会一直阻塞在 Selector 上，造成 Netty 无法工作？

:::

笔者相信大家现在心里应该有了答案。在《1.2.2 Reactor 开始轮询 IO 就绪事件》小节一开始介绍过，当 Reactor 正在 Selector 上阻塞时，如果此时用户线程向 Reactor 提交了异步任务，Reactor 线程会通过 `execute` 方法被唤醒。

------

流程到这里，我们就讲解完了 Reactor 中最重要也是最核心的逻辑：

* **轮询 Channel 上的 IO 就绪事件的处理流程** 

当 Reactor 轮询到有 IO 活跃事件或者有异步任务需要执行时，就会从 Selector 上被唤醒。接下来，该介绍 Reactor 被唤醒之后是如何处理 IO 就绪事件以及如何执行异步任务。

Netty 毕竟是一个网络框架，因此它会优先处理 Channel 上的 IO 事件。基于这个事实，Netty 不会容忍异步任务被无限制地执行，从而影响 IO 吞吐量。

Netty 通过 `ioRatio` 变量来调配 Reactor 线程在处理 IO 事件和执行异步任务之间的 CPU 时间分配比例。

下面我们就来看一下这个执行时间比例的分配逻辑是什么样的~~~

## 2、Reactor处理 IO 与处理异步任务的时间比例分配

 无论何时，当有 IO 就绪事件到来时，Reactor 都需要保证 IO 事件被及时且完整地处理完。而 `ioRatio` 主要限制的是执行异步任务所需的时间，以防止 Reactor 线程在处理异步任务时花费过长时间，从而导致 I/O 事件得不到及时处理。  

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311611188.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031161128993" style="zoom:33%;" />

```java
// 调整 Reactor 线程执行 IO 事件和执行异步任务的 CPU 时间比例，默认 50，表示执行 IO 事件和异步任务的时间比例是一比一
final int ioRatio = this.ioRatio;
boolean ranTasks;

if (ioRatio == 100) { // 先一股脑执行 IO 事件，再一股脑执行异步任务（无时间限制）
    try {
        if (strategy > 0) {
            // 如果有 IO 就绪事件，则处理 IO 就绪事件
            processSelectedKeys();
        }
    } finally {
        // 确保始终运行任务
        // 处理所有异步任务
        ranTasks = runAllTasks();
    }
} else if (strategy > 0) { // 先执行 IO 事件，用时 ioTime，执行异步任务只能用时 ioTime * (100 - ioRatio) / ioRatio
    final long ioStartTime = System.nanoTime();
    try {
        processSelectedKeys();
    } finally {
        // 确保始终运行任务
        final long ioTime = System.nanoTime() - ioStartTime;
        // 限定在超时时间内处理有限的异步任务，防止 Reactor 线程处理异步任务时间过长而导致 I/O 事件阻塞
        ranTasks = runAllTasks(ioTime * (100 - ioRatio) / ioRatio);
    }
} else { // 没有 IO 就绪事件处理，则只执行异步任务，最多执行 64 个，防止 Reactor 线程处理异步任务时间过长而导致 I/O 事件阻塞
    ranTasks = runAllTasks(0); // This will run the minimum number of tasks
}
```

- 当 `ioRatio = 100` 时，表示无需考虑执行时间的限制。当有 IO 就绪事件时（`strategy > 0`），Reactor 线程需要优先处理 IO 就绪事件。处理完 IO 事件后，执行所有的异步任务，包括：普通任务、尾部任务和定时任务，且无时间限制。

* 当 `ioRatio` 设置的值不为 100 时，默认为 50。需要先统计出执行 IO 事件的用时 `ioTime`，然后根据公式：

$$ 限制时间= ioRatio \frac{ioTime×(100−ioRatio)}{ioRatio} $$

计算出后续执行异步任务的限制时间。也就是说，Reactor 线程需要在这个限定的时间内执行有限的异步任务，以防止因处理异步任务时间过长而导致 I/O 事件得不到及时处理。默认情况下，执行 IO 事件用时和执行异步任务用时的比例设置为 1:1。`ioRatio` 设置得越高，则 Reactor 线程执行异步任务的时间占比越小。

要想得到 Reactor 线程执行异步任务所需的时间限制，必须知道执行 IO 事件的用时 `ioTime`，然后根据 `ioRatio` 计算出执行异步任务的时间限制。

**如果此时并没有 IO 就绪事件需要 Reactor 线程处理，这种情况下我们无法得到** `ioTime`**，那怎么得到执行异步任务的限制时间呢？**

在这种特殊情况下，Netty 只允许 Reactor 线程最多执行 64 个异步任务，然后就结束执行，转去继续轮询 IO 就绪事件。核心目的仍然是防止 Reactor 线程因处理异步任务时间过长而导致 I/O 事件得不到及时处理。

默认情况下，当 Reactor 有异步任务需要处理但没有 IO 就绪事件时，Netty 只会允许 Reactor 线程执行最多 64 个异步任务。

现在我们对 Reactor 处理 IO 事件和异步任务的整体框架已有了解，接下来我们将分别介绍 Reactor 线程在处理 IO 事件和异步任务的具体逻辑。

## 3、Reactor 线程处理 IO 就绪事件

```java
//该字段为持有 selector 对象 selectedKeys 的引用，当 IO 事件就绪时，直接从这里获取
private SelectedSelectionKeySet selectedKeys;

private void processSelectedKeys() {
    //是否采用netty优化后的selectedKey集合类型 是由变量DISABLE_KEY_SET_OPTIMIZATION决定的 默认为false
    if (selectedKeys != null) {
        processSelectedKeysOptimized();
    } else {
        processSelectedKeysPlain(selector.selectedKeys());
    }
}
```

## 4、Reactor 线程处理异步任务

Netty 关于处理异步任务的方法有两个：

- **无超时时间限制的** `runAllTasks()` **方法**。当 `ioRatio` 设置为 100 时，Reactor 线程会首先处理所有的 IO 就绪事件，然后再执行所有的异步任务，此过程中并没有时间限制。
- **有超时时间限制的** `runAllTasks(long timeoutNanos)` **方法**。当 `ioRatio` 不等于 100 时，Reactor 线程执行异步任务会受到时间限制。此时，Reactor 线程会优先处理完所有的 IO 就绪事件，并统计执行 IO 任务的耗时 `ioTime`。然后，根据公式：

$$ \text{超时时间} = \frac{\text{ioTime} \times (100 - \text{ioRatio})}{\text{ioRatio}} $$

计算出 Reactor 线程执行异步任务的超时时间。在这个超时时间限制范围内，执行有限的异步任务。

下面我们来分别看这两个执行异步任务的方法的处理逻辑：

### runAllTasks()

```java
protected boolean runAllTasks() {
    assert inEventLoop();
    boolean fetchedAll;
    boolean ranAtLeastOne = false;

    do {
        //将到达执行时间的定时任务转存到普通任务队列taskQueue中，统一由Reactor线程从taskQueue中取出执行
        fetchedAll = fetchFromScheduledTaskQueue();
        if (runAllTasksFrom(taskQueue)) {
            ranAtLeastOne = true;
        }
    } while (!fetchedAll); // keep on processing until we fetched all scheduled tasks.

    if (ranAtLeastOne) {
        lastExecutionTime = ScheduledFutureTask.nanoTime();
    }
    //执行尾部队列任务
    afterRunningAllTasks();
    return ranAtLeastOne;
}
```

Reactor 线程执行异步任务的核心逻辑如下：

1. 将到期的定时任务从定时任务队列 `scheduledTaskQueue` 中取出，并转存到普通任务队列 `taskQueue` 中。
2. 由 Reactor 线程统一从普通任务队列 `taskQueue` 中取出任务并执行。
3. 在 Reactor 线程执行完定时任务和普通任务后，开始执行存储于尾部任务队列 `tailTasks` 中的尾部任务。

下面我们将分别看一下上述几个核心步骤的实现：

#### fetchFromScheduledTaskQueue

```java
/**
 * 从定时任务队列中取出达到deadline执行时间的定时任务
 * 将定时任务 转存到 普通任务队列taskQueue中，统一由Reactor线程从taskQueue中取出执行
 *
 * */
private boolean fetchFromScheduledTaskQueue() {
    if (scheduledTaskQueue == null || scheduledTaskQueue.isEmpty()) {
        return true;
    }
    long nanoTime = AbstractScheduledEventExecutor.nanoTime();
    for (;;) {
        //从定时任务队列中取出到达执行deadline的定时任务  deadline <= nanoTime
        Runnable scheduledTask = pollScheduledTask(nanoTime);
        if (scheduledTask == null) {
            return true;
        }
        if (!taskQueue.offer(scheduledTask)) {
            // taskQueue没有空间容纳 则在将定时任务重新塞进定时任务队列中等待下次执行
            scheduledTaskQueue.add((ScheduledFutureTask<?>) scheduledTask);
            return false;
        }
    }
}
```

1. 获取当前要执行`异步任务`的时间点`nanoTime`

```java
final class ScheduledFutureTask<V> extends PromiseTask<V> implements ScheduledFuture<V>, PriorityQueueNode {
    private static final long START_TIME = System.nanoTime();

    static long nanoTime() {
        return System.nanoTime() - START_TIME;
    }
}
```

2. 从定时任务队列中找出`deadline <= nanoTime`的异步任务。也就是说找出所有到期的定时任务。

```java
protected final Runnable pollScheduledTask(long nanoTime) {
    assert inEventLoop();

    //从定时队列中取出要执行的定时任务  deadline <= nanoTime
    ScheduledFutureTask<?> scheduledTask = peekScheduledTask();
    if (scheduledTask == null || scheduledTask.deadlineNanos() - nanoTime > 0) {
        return null;
    }
    //符合取出条件 则取出
    scheduledTaskQueue.remove();
    scheduledTask.setConsumed();
    return scheduledTask;
}
```

3. 将`到期的定时任务`插入到普通任务队列`taskQueue`中，如果`taskQueue`已经没有空间容纳新的任务，则将`定时任务`重新塞进`定时任务队列`中等待下次拉取。

```java
if (!taskQueue.offer(scheduledTask)) {
    scheduledTaskQueue.add((ScheduledFutureTask<?>) scheduledTask);
    return false;
}
```

4. `fetchFromScheduledTaskQueue`的返回值为`true`时表示到期的定时任务已经全部拉取出来并转存到普通任务队列中。返回值为`false`时表示到期的定时任务只拉取出来一部分，因为这时普通任务队列已经满了，当执行完普通任务时，还需要在进行一次拉取。

当`到期的定时任务`从定时任务队列中拉取完毕或者当普通任务队列已满时，这时就会停止拉取，开始执行普通任务队列中的`异步任务`。

#### runAllTasksFrom

```java
protected final boolean runAllTasksFrom(Queue<Runnable> taskQueue) {
    Runnable task = pollTaskFrom(taskQueue);
    if (task == null) {
        return false;
    }
    for (;;) {
        safeExecute(task);
        task = pollTaskFrom(taskQueue);
        if (task == null) {
            return true;
        }
    }
}
```

1. 首先`runAllTasksFrom `方法的返回值表示是否执行了至少一个异步任务。后面会赋值给`ranAtLeastOne`变量，这个返回值我们后续会用到
2. 从普通任务队列中拉取`异步任务`

```java
protected static Runnable pollTaskFrom(Queue<Runnable> taskQueue) {
    for (;;) {
        Runnable task = taskQueue.poll();
        if (task != WAKEUP_TASK) {
            return task;
        }
    }
}
```

3. Reactor线程 执行`异步任务`。

```java
protected static void safeExecute(Runnable task) {
    try {
        task.run();
    } catch (Throwable t) {
        logger.warn("A task raised an exception. Task: {}", task, t);
    }
}
```

#### afterRunningAllTasks

```java
if (ranAtLeastOne) {
    lastExecutionTime = ScheduledFutureTask.nanoTime();
}
//执行尾部队列任务
afterRunningAllTasks();
return ranAtLeastOne;
```

如果`Reactor线程`执行了至少一个`异步任务`，那么设置`lastExecutionTime`，并将`ranAtLeastOne标识`返回。这里的`ranAtLeastOne标识`就是`runAllTasksFrom方法`的返回值。

最后执行收尾任务，也就是执行尾部任务队列中的尾部任务。

```java
@Override
protected void afterRunningAllTasks() {
    runAllTasksFrom(tailTasks);
}
```

### runAllTasks(long timeoutNanos)

::: tip

这里在处理`异步任务`的核心逻辑还是和之前一样的，只不过就是多了对`超时时间`的控制。

:::

```java
protected boolean runAllTasks(long timeoutNanos) {
    fetchFromScheduledTaskQueue();
    Runnable task = pollTask();
    if (task == null) {
        //普通队列中没有任务时  执行队尾队列的任务
        afterRunningAllTasks();
        return false;
    }

    //异步任务执行超时deadline
    final long deadline = timeoutNanos > 0 ? ScheduledFutureTask.nanoTime() + timeoutNanos : 0;
    long runTasks = 0;
    long lastExecutionTime;
    for (;;) {
        safeExecute(task);
        runTasks ++;
        //每运行64个异步任务 检查一下 是否达到 执行deadline
        if ((runTasks & 0x3F) == 0) {
            lastExecutionTime = ScheduledFutureTask.nanoTime();
            if (lastExecutionTime >= deadline) {
                //到达异步任务执行超时deadline，停止执行异步任务
                break;
            }
        }

        task = pollTask();
        if (task == null) {
            lastExecutionTime = ScheduledFutureTask.nanoTime();
            break;
        }
    }

    afterRunningAllTasks();
    this.lastExecutionTime = lastExecutionTime;
    return true;
}
```

1. 通过 `fetchFromScheduledTaskQueue` 方法从 Reactor 中的定时任务队列中拉取到期的定时任务，并转存到普通任务队列中。当普通任务队列已满或者到期定时任务全部拉取完毕时，停止拉取。
2. 将 `ScheduledFutureTask.nanoTime() + timeoutNanos` 作为 Reactor 线程执行异步任务的超时时间点 `deadline`。
3. **由于系统调用** `System.nanoTime()` **需要一定的系统开销，因此每执行完 64 个异步任务时，才会检查一下执行时间是否到达了 `deadline`**。
   * 如果到达了执行截止时间 `deadline`，则退出并停止执行异步任务
   * 如果没有到达 `deadline`，则继续从普通任务队列中取出任务并循环执行下去。

------

流流程走到这里，我们就对 Reactor 的整个运行框架以及如何轮询 IO 就绪事件、如何处理 IO 就绪事件、如何执行异步任务的具体实现逻辑进行了全面剖析。

下面还有一个小小的尾巴，就是 Netty 是如何解决文章开头提到的 JDK NIO Epoll 的空轮询 BUG 的。让我们一起来看一下吧~~~

## 5、解决 JDK Epoll 空轮询 BUG

前边提到，由于`JDK NIO Epoll的空轮询BUG`存在，这样会导致`Reactor线程`在没有任何事情可做的情况下被意外唤醒，导致CPU空转。

其实Netty也没有从根本上解决这个`JDK BUG`，而是选择巧妙的绕过这个`BUG`。

下面我们来看下Netty是如何做到的。

![image-20241030161810063](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301618120.png)

在`Reactor线程`处理完`IO就绪事件`和`异步任务`后，会检查这次`Reactor线程`被唤醒有没有执行过异步任务和有没有`IO就绪的Channel`。

- `boolean ranTasks` 这时候就派上了用场，这个`ranTasks`正是前边我们在讲`runAllTasks方法`时提到的返回值。用来表示是否执行过至少一次`异步任务`。
- `int strategy` 正是`JDK NIO Selector`的`select方法`的返回值，用来表示`IO就绪`的`Channel个数`。

如果`ranTasks = false 并且 strategy = 0`这代表`Reactor线程`本次既没有`异步任务`执行也没有`IO就绪`的`Channel`需要处理却被意外的唤醒。等于是空转了一圈啥也没干。

这种情况下Netty就会认为可能已经触发了`JDK NIO Epoll的空轮询BUG`

```java
int SELECTOR_AUTO_REBUILD_THRESHOLD = SystemPropertyUtil.getInt("io.netty.selectorAutoRebuildThreshold", 512);

private boolean unexpectedSelectorWakeup(int selectCnt) {
      ..................省略...............

    /**
     * 走到这里的条件是 既没有IO就绪事件，也没有异步任务，Reactor线程从Selector上被异常唤醒
     * 这种情况可能是已经触发了JDK Epoll的空轮询BUG，如果这种情况持续512次 则认为可能已经触发BUG，于是重建Selector
     *
     * */
    if (SELECTOR_AUTO_REBUILD_THRESHOLD > 0 &&
            selectCnt >= SELECTOR_AUTO_REBUILD_THRESHOLD) {
        // The selector returned prematurely many times in a row.
        // Rebuild the selector to work around the problem.
        logger.warn("Selector.select() returned prematurely {} times in a row; rebuilding Selector {}.",
                selectCnt, selector);
        rebuildSelector();
        return true;
    }
    return false;
}
```

- 如果 `Reactor` 这种意外唤醒的次数 `selectCnt` 超过了配置的次数 `SELECTOR_AUTO_REBUILD_THRESHOLD`，那么 Netty 就会认定这种情况可能已经触发了 **JDK NIO Epoll 空轮询 BUG**，因此会重建 `Selector`（将之前注册的所有 Channel 重新注册到新的 Selector 上并关闭旧的 Selector），并将 `selectCnt` 计数归 **0**。

`SELECTOR_AUTO_REBUILD_THRESHOLD` 默认为 **512**，可以通过系统变量 `-D io.netty.selectorAutoRebuildThreshold` 指定自定义数值。

- 如果 `selectCnt` 小于 `SELECTOR_AUTO_REBUILD_THRESHOLD`，则返回不做任何处理，**`selectCnt`** 继续计数。

Netty 就这样通过计数 `Reactor` 被意外唤醒的次数。如果计数 `selectCnt` 达到了 **512次**，则通过 **重建 Selector** 巧妙地绕开了 **JDK NIO Epoll 空轮询 BUG**。

## 总结

本文花了大量篇幅介绍了 `Reactor` 整体的运行框架，并深入探讨了 `Reactor` 核心工作模块的具体实现逻辑。

通过本文的介绍，我们了解到 `Reactor` 如何轮询注册在其上的所有 **Channel** 上感兴趣的 IO 事件，以及 **Reactor** 如何处理 IO 就绪的事件，如何执行 **Netty** 框架中提交的异步任务和定时任务。

最后，本文介绍了 **Netty** 如何巧妙地绕过 JDK NIO **Epoll** 空轮询的 BUG，从而达到解决问题的目的。

提炼出新的解决问题的思路：**解决问题的最高境界就是不解决它，巧妙地绕过去** ！！

好了，本文的内容就到这里了，我们下篇文章见 

