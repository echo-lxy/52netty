# BootStrap 初始化 Netty 服务

## 前言

在完成了 [《网络通信层 》](/netty_source_code_parsing/network_program/socket_network_programmingg)的学习之后，我们终于可以正式开始 Netty 的源码学习了！

先来引出 Netty 中使用的 **主从 Reactor IO 线程模型**

![image-20241031153016594](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311530775.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

它在实现上又与 **Doug Lea** 在 [Scalable IO in Java](https://gee.cs.oswego.edu/dl/cpjslides/nio.pdf) 论文中提到的经典 **主从 Reactor 多线程模型** 有所差异

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029194601543.png" alt="image-20241029194601543" style="zoom:50%;" />

## Netty 中的 Main Sub Reactor Group 模型

在 Netty 中，**Reactor** 是以 **Group** 的形式组织的。主从 Reactor 模式在 Netty 中表现为主从 Reactor 组，每个 Reactor 组中包含多个 Reactor，用于执行具体的 I/O 任务。

当然，Reactor 在 Netty 中不仅仅用于执行 I/O 任务，更多的功能将在后续进行讨论。

### Main Reactor Group

**Main Reactor Group** 中的 Reactor 数量取决于服务端需要监听的端口数。通常情况下，服务端程序只会监听一个端口，因此 Main Reactor Group 中仅会有一个 **Main Reactor 线程** 来负责最重要的工作：

- **绑定端口地址**：将服务端绑定到指定的端口上，监听连接请求。
- **接收客户端连接**：当客户端发起连接请求时，Main Reactor 负责接收并处理。
- **为客户端创建对应的 SocketChannel**：为每个连接的客户端创建一个 `SocketChannel`。
- **分配到 Sub Reactor**：将客户端的 `SocketChannel` 分配给一个固定的 **Sub Reactor**。

### Sub Reactor Group

**Sub Reactor Group** 包含多个 Reactor 线程，线程的数量可以通过系统参数 `-D io.netty.eventLoopThreads` 进行配置。默认情况下，Sub Reactor 线程的数量为 **CPU 核数 \* 2**。这些线程主要负责以下任务：

- **轮询客户端 `SocketChannel` 的 I/O 事件**：Sub Reactor 线程会不断地轮询，检测客户端 `SocketChannel` 上的 I/O 就绪事件（如读写操作）。
- **处理 I/O 事件**：当 I/O 事件就绪时，Sub Reactor 线程会处理这些事件，如数据读取、写入等操作。
- **执行异步任务**：此外，Sub Reactor 线程还负责执行一些异步任务，确保系统的高效性和非阻塞特性。

在 Netty 中，每个客户端的 **SocketChannel** 都会分配给一个固定的 **Sub Reactor**。一个 Sub Reactor 可以处理多个客户端的 `SocketChannel`，这种设计有以下几个优势：

1. **负载分担**：将服务端承载的所有客户端连接分散到多个 Sub Reactor 中，避免单个线程过载，从而提升系统的并发处理能力。
2. **线程安全**：每个客户端的 `SocketChannel` 只分配给一个固定的 Sub Reactor，这样在处理该客户端的 I/O 操作时，不会涉及多个线程的竞争，保证了 I/O 处理的线程安全性。

通过这样的机制，Netty 能够高效处理大量的客户端连接，确保系统在高并发场景下的稳定运行。

## EchoServer 代码模板

阅读源代码时，最主要的关注点就是源代码包中的 `example` 目录。这其中包含了对核心功能的基本使用示例。

请务必记住这些示例代码，因为在本书中会多次提到它们。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730000821151-f14c54b4-0fa7-40cb-bb3f-b8fc31e4fcb7.png)

```java
/**
 * Echoes back any received data from a client.
 */
public final class EchoServer {
    static final int PORT = Integer.parseInt(System.getProperty("port", "8007"));

    public static void main(String[] args) throws Exception {
        // Configure the server.
        //创建主从Reactor线程组
        EventLoopGroup bossGroup = new NioEventLoopGroup(1);
        EventLoopGroup workerGroup = new NioEventLoopGroup();
        final EchoServerHandler serverHandler = new EchoServerHandler();
        try {
            ServerBootstrap b = new ServerBootstrap();
            b.group(bossGroup, workerGroup)//配置主从Reactor
             .channel(NioServerSocketChannel.class)//配置主Reactor中的channel类型
             .option(ChannelOption.SO_BACKLOG, 100)//设置主Reactor中channel的option选项
             .handler(new LoggingHandler(LogLevel.INFO))//设置主Reactor中Channel->pipline->handler
             .childHandler(new ChannelInitializer<SocketChannel>() {//设置从Reactor中注册channel的pipeline
                 @Override
                 public void initChannel(SocketChannel ch) throws Exception {
                     ChannelPipeline p = ch.pipeline();
                     //p.addLast(new LoggingHandler(LogLevel.INFO));
                     p.addLast(serverHandler);
                 }
             });

            // Start the server. 绑定端口启动服务，开始监听accept事件
            ChannelFuture f = b.bind(PORT).sync();
            // Wait until the server socket is closed.
            f.channel().closeFuture().sync();
        } finally {
            // Shut down all event loops to terminate all threads.
            bossGroup.shutdownGracefully();
            workerGroup.shutdownGracefully();
        }
    }
}
```

## 创建主从 Reactor 线程组

在编写 Netty 服务端程序模板的开头，首先需要创建两个 Reactor 线程组：

- **主 Reactor 线程组 (`bossGroup`)**：用于监听客户端连接，负责创建客户端连接的 `NioSocketChannel`，并将创建好的 `NioSocketChannel` 注册到从 Reactor 线程组中的某个固定的 Reactor 上。
- **从 Reactor 线程组 (`workerGroup`)**：`workerGroup` 中的 Reactor 负责监听并处理绑定在其上的客户端连接 `NioSocketChannel` 的 I/O 就绪事件，执行异步任务。

在 Netty 中：

- `EventLoopGroup` 是 `Reactor Group` 的实现类；
- `EventLoop` 则对应于 `Reactor` 的实现类。

```java
//创建主从Reactor线程组
EventLoopGroup bossGroup = new NioEventLoopGroup(1);
EventLoopGroup workerGroup = new NioEventLoopGroup();
```

---

在 Netty 中，Reactor 线程组的实现类为 `NioEventLoopGroup`。在创建 `bossGroup` 和 `workerGroup` 时，通常会用到 `NioEventLoopGroup` 的两个构造函数：

- **带** `nThreads` **参数的构造函数**

```java
public NioEventLoopGroup(int nThreads)
```

这个构造函数允许指定线程池中的线程数量 (`nThreads`)。`nThreads` 的数量一般与系统的 CPU 核数相关，用于控制并发处理能力。

- **不带** `nThreads` **参数的默认构造函数**

```java
public NioEventLoopGroup()
```

在不指定线程数量时，`NioEventLoopGroup` 会默认根据系统资源（例如 CPU 核数）自动设置线程数量，以实现性能优化。

```java
public class NioEventLoopGroup extends MultithreadEventLoopGroup {

    public NioEventLoopGroup() {
        this(0);
    }

    public NioEventLoopGroup(int nThreads) {
        this(nThreads, (Executor) null);
    }

    ......................省略...........................
}
```

`nThreads` 参数表示当前要创建的 `Reactor 线程组` 内包含多少个 `Reactor 线程`。如果不指定 `nThreads` 参数，则会采用默认的 `Reactor 线程` 个数，用 `0` 表示。

最终会调用到构造函数：

```java
public NioEventLoopGroup(int nThreads, Executor executor, final SelectorProvider selectorProvider,
                         final SelectStrategyFactory selectStrategyFactory) {
    super(nThreads, executor, selectorProvider, selectStrategyFactory, RejectedExecutionHandlers.reject());
}
```

下面简单介绍下构造函数中这几个参数的作用，后面我们在讲解本文主线的过程中还会提及这几个参数，您无需过多纠缠，只需对其有一个初步印象。

- **Executor executor**：负责启动 Reactor 线程，以便它可以开始工作。Reactor 线程组 `NioEventLoopGroup` 负责创建 Reactor 线程，并在创建时传入 `executor`。
- **RejectedExecutionHandler**：当向 Reactor 添加异步任务失败时，执行的拒绝策略。Reactor 的任务不仅包括监听 IO 活跃事件和处理 IO 任务，还包括处理异步任务。在这里简单了解这个概念即可，后文会对此进行详细介绍。
- **SelectorProvider selectorProvider**：Reactor 中的 IO 模型是 IO 多路复用模型，在 JDK NIO 中对应实现为 `java.nio.channels.Selector`（即上篇文章提到的 select、poll、epoll）。每个 Reactor 包含一个 Selector，用于轮询注册在该 Reactor 上的所有 Channel 的 IO 事件。`SelectorProvider` 用于创建 Selector。
- **SelectStrategyFactory selectStrategyFactory**：Reactor 的核心任务是轮询注册在其上的 Channel 的 IO 就绪事件，`SelectStrategyFactory` 用于指定轮询策略，默认策略为 `DefaultSelectStrategyFactory.INSTANCE`。

最终，这些参数将传递给 `NioEventLoopGroup` 的父类构造器。接下来，我们来看看 `NioEventLoopGroup` 类的继承结构：

![image-20241031153130559](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311531612.png)

`NioEventLoopGroup` 类的继承结构乍一看比较复杂，大家不要慌，笔者会随着主线的深入慢慢地介绍这些父类接口。我们现在重点关注 **Multithread** 前缀的类。

我们知道，`NioEventLoopGroup` 是 Netty 中的 Reactor 线程组的实现。既然是线程组，它肯定负责管理和创建多个 Reactor 线程。因此，**Multithread** 前缀的类定义的行为自然是针对 Reactor 线程组内多个 Reactor 线程的创建和管理工作。

### MultithreadEventLoopGroup

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730001426286-c4ce1251-ad5e-4fe3-be7f-1979b794f408.png)

`MultithreadEventLoopGroup` 的主要功能是确定 Reactor 线程组内的 Reactor 数量。默认的 Reactor 数量存储在字段 `DEFAULT_EVENT_LOOP_THREADS` 中。通过 `static {}` 静态代码块，我们可以看到默认 Reactor 数量的获取逻辑：

- 可以通过系统变量 `-D io.netty.eventLoopThreads` 指定。
- 如果未指定，则默认值为 `NettyRuntime.availableProcessors() * 2`。

当 `nThread` 参数设置为 `0`，采用默认设置时，Reactor 线程组内的 Reactor 数量会被设置为 `DEFAULT_EVENT_LOOP_THREADS`。

### MultithreadEventExecutorGroup

`MultithreadEventExecutorGroup`这里就是本小节的核心，主要用来定义创建和管理`Reactor`的行为。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730001538497-889235b8-cf57-416a-8773-13d2340209d6.png)

首先介绍一个新的构造器参数：`EventExecutorChooserFactory chooserFactory`。

当客户端完成三次握手后，Main Reactor 会创建一个客户端连接 `NioSocketChannel`，并将其绑定到 Sub Reactor Group 中的某个固定 Reactor 上。那么，该连接具体绑定到哪个 Sub Reactor 上呢？这就是由 `chooserFactory` 决定的绑定策略。默认的绑定策略为 `DefaultEventExecutorChooserFactory`。

**下面就是本小节的主题：** `Reactor线程组` **的创建过程：**

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730001691452-3db196c0-0a16-47aa-a460-b85348755c3e.png)

接下来开始解释上述代码

#### 1、创建用于启动 Reactor 线程的 executor

`ThreadPerTaskExecutor` 只用来创建 Reactor 线程，别无他用。这里的 `executor` 负责启动 Reactor 线程。从创建的源码中，我们可以看到 `executor` 的类型为 `ThreadPerTaskExecutor`。

```Java
public final class ThreadPerTaskExecutor implements Executor {
    private final ThreadFactory threadFactory;

    public ThreadPerTaskExecutor(ThreadFactory threadFactory) {
        this.threadFactory = ObjectUtil.checkNotNull(threadFactory, "threadFactory");
    }

    @Override
    public void execute(Runnable command) {
        threadFactory.newThread(command).start();
    }
}
```

我们看到，`ThreadPerTaskExecutor` 做的事情很简单。从它的命名前缀 **ThreadPerTask** 我们可以猜出它的工作方式：就是来一个任务就创建一个线程执行。而创建的这个线程正是 Netty 的核心引擎 Reactor 线程。

一个 `EventLoopGroup` 对应一个 `ThreadPerTaskExecutor`。在 Reactor 线程启动的时候，Netty 会将 Reactor 线程要做的事情封装成 `Runnable`，丢给 `executor` 启动。

Reactor 线程的核心就是一个死循环，不停地轮询 IO 就绪事件，处理 IO 事件，执行异步任务。一刻也不停歇，堪称 996 的典范。

这里向大家先卖个关子，**“Reactor 线程是何时启动的呢？”**

#### 2、创建 Reactor

Reactor 线程组 `NioEventLoopGroup` 包含多个 Reactor，这些 Reactor 存放于 `private final EventExecutor[] children` 数组中。

因此，下面的工作就是创建 `nThread` 个 Reactor，并将它们存放于 `EventExecutor[] children` 字段中。我们来看一下用于创建 Reactor 的 `newChild(executor, args)` 方法：

`newChild` 方法是 `MultithreadEventExecutorGroup` 中的一个抽象方法，提供给具体子类实现。

```java
protected abstract EventExecutor newChild(Executor executor, Object... args) throws Exception;
```

这里我们解析的是 `NioEventLoopGroup`，我们来看一下 `newChild` 在该类中的实现：

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730001885437-1e25f276-58d0-4f22-8ca3-06ceec5b5b71.png)

前面提到的众多构造器参数，这里会通过可变参数 `Object... args` 传入到 Reactor 类 `NioEventLoop` 的构造器中。

这里介绍一个新的参数 **EventLoopTaskQueueFactory**。前面提到 Netty 中的 Reactor 主要工作是轮询注册其上的所有 Channel 的 IO 就绪事件，处理这些 IO 就绪事件。除了这些主要的工作外，Netty 为了极致地压榨 Reactor 的性能，还会让它执行一些异步任务。既然要执行异步任务，那么 Reactor 中就需要一个队列来保存这些任务。

**EventLoopTaskQueueFactory** 就是用来创建这样的一个队列，以保存 Reactor 中待执行的异步任务。

可以把 Reactor 理解为一个单线程的线程池，类似于 JDK 中的 `SingleThreadExecutor`，仅用一个线程来执行轮询 IO 就绪事件、处理 IO 就绪事件以及执行异步任务。同时，待执行的异步任务保存在 Reactor 里的 `taskQueue` 中。

【TODO】【**EventLoopTaskQueueFactory**】

```java
public final class NioEventLoop extends SingleThreadEventLoop {

    //用于创建JDK NIO Selector,ServerSocketChannel
    private final SelectorProvider provider;

    //Selector轮询策略 决定什么时候轮询，什么时候处理IO事件，什么时候执行异步任务
    private final SelectStrategy selectStrategy;
    /**
     * The NIO {@link Selector}.
     */
    private Selector selector;
    private Selector unwrappedSelector;

    NioEventLoop(NioEventLoopGroup parent, Executor executor, SelectorProvider selectorProvider,
                 SelectStrategy strategy, RejectedExecutionHandler rejectedExecutionHandler,
                 EventLoopTaskQueueFactory queueFactory) {
        super(parent, executor, false, newTaskQueue(queueFactory), newTaskQueue(queueFactory),
                rejectedExecutionHandler);
        this.provider = ObjectUtil.checkNotNull(selectorProvider, "selectorProvider");
        this.selectStrategy = ObjectUtil.checkNotNull(strategy, "selectStrategy");
        final SelectorTuple selectorTuple = openSelector();
        this.selector = selectorTuple.selector;
        this.unwrappedSelector = selectorTuple.unwrappedSelector;
    }
}
```

这里就正式开始了 Reactor 的创建过程。我们知道，Reactor 的核心是采用 IO 多路复用模型来对客户端连接上的 IO 事件进行监听，因此最重要的任务是创建 Selector（JDK NIO 中 IO 多路复用技术的实现）。

可以将 Selector 理解为我们在 [《IO 多路复用》](/netty_source_code_parsing/network_program/io_multiplexing) 中介绍的 `select`、`poll`、`epoll`。它是 JDK NIO 对操作系统内核提供的这些 IO 多路复用技术的封装。

##### openSelector()

`openSelector` 是 `NioEventLoop` 类中用于创建 IO 多路复用的 `Selector`，并对创建出来的 JDK NIO 原生 `Selector` 进行性能优化。

首先，它会通过 `SelectorProvider#openSelector` 创建 JDK NIO 原生的 `Selector`。

```java
private SelectorTuple openSelector() {
    final Selector unwrappedSelector;
    try {
        //通过JDK NIO SelectorProvider创建Selector
        unwrappedSelector = provider.openSelector();
    } catch (IOException e) {
        throw new ChannelException("failed to open a new selector", e);
    }

    ..................省略.............
}
```

`SelectorProvider` 会根据操作系统的不同选择 JDK 在不同操作系统版本下的对应 `Selector` 的实现。在 Linux 系统下，它会选择 `Epoll`，而在 Mac 系统下则会选择 `Kqueue`。

接下来，我们来看看 `SelectorProvider` 是如何实现对不同操作系统下 IO 多路复用的自动适配的。

##### SelectorProvider

```java
public NioEventLoopGroup(ThreadFactory threadFactory) {
    this(0, threadFactory, SelectorProvider.provider());
}
```

`SelectorProvider` 在前面介绍的 `NioEventLoopGroup` 类构造函数中通过调用 `SelectorProvider.provider()` 被加载，并在 `NioEventLoopGroup#newChild` 方法中的可变长参数 `Object... args` 传递到 `NioEventLoop` 中的 `private final SelectorProvider provider` 字段中。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730002340847-d9863943-a60e-488b-9432-c1e20e74e9de.png)

从`SelectorProvider`加载源码中我们可以看出，`SelectorProvider`的加载方式有三种，优先级如下：

1. 通过系统变量`-D java.nio.channels.spi.SelectorProvider`指定`SelectorProvider`的自定义实现类`全限定名`。通过`应用程序类加载器(Application Classloader)`加载。

```java
private static boolean loadProviderFromProperty() {
    String cn = System.getProperty("java.nio.channels.spi.SelectorProvider");
    if (cn == null)
        return false;
    try {
        Class<?> c = Class.forName(cn, true,
                                   ClassLoader.getSystemClassLoader());
        provider = (SelectorProvider)c.newInstance();
        return true;
    }
    .................省略.............
}
```

2. 通过`SPI`方式加载。在工程目录`META-INF/services`下定义名为`java.nio.channels.spi.SelectorProvider`的`SPI文件`，文件中第一个定义的`SelectorProvider`实现类全限定名就会被加载。

```java
private static boolean loadProviderAsService() {

    ServiceLoader<SelectorProvider> sl =
        ServiceLoader.load(SelectorProvider.class,
                           ClassLoader.getSystemClassLoader());
    Iterator<SelectorProvider> i = sl.iterator();
    for (;;) {
        try {
            if (!i.hasNext())
                return false;
            provider = i.next();
            return true;
        } catch (ServiceConfigurationError sce) {
            if (sce.getCause() instanceof SecurityException) {
                // Ignore the security exception, try the next provider
                continue;
            }
            throw sce;
        }
    }
}
```

3. 如果以上两种方式均未被定义，那么就采用`SelectorProvider`系统默认实现`sun.nio.ch.DefaultSelectorProvider`。笔者当前使用的操作系统是`MacOS`，从源码中我们可以看到自动适配了`KQueue`实现。

```java
public class DefaultSelectorProvider {
    private DefaultSelectorProvider() {
    }

    public static SelectorProvider create() {
        return new KQueueSelectorProvider();
    }
}
```

不同操作系统中，JDK 对于 `DefaultSelectorProvider` 的实现有所不同：

- **Linux**：
  - 内核版本 **2.6 以上**：对应的选择器为 **Epoll**。
  - 内核版本 **2.6 以下**：对应的选择器为 **Poll**。
- **MacOS**：对应的选择器为 **KQueue**。

接下来，我们继续回到 `io.netty.channel.nio.NioEventLoop#openSelector` 的主线。

##### SelectStrategy

`SelectStrategy` 是 Reactor 线程在循环时的选择策略接口，提供了控制选择循环行为的能力。例如，如果有事件需要立即处理，则可以延迟或完全跳过阻塞选择操作。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730003016390-3ee70bdb-71c0-4f16-9fbf-b8bc7e616486.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730003126661-471a3664-5f6f-48ab-b243-60e4b50ef41e.png)

主要是 `calculateStrategy` 方法。每个 Reactor 都是在一个死循环中运行，在这个过程中，它会处理 IO 就绪事件和异步队列等任务。然而，具体如何处理这两者，需要一个协调机制来决定先处理哪个任务、后处理哪个任务，这就需要一个策略。

`SelectStrategy` 定义了三种策略，但在实际应用中，我们需要先通过计算确定采用哪一种策略。`calculateStrategy` 方法正是这个计算和处理策略的关键所在。

##### newTaskQueue

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730003216157-2af1dc3e-5982-4399-bacb-d6ab84a67a02.png)

我们继续回到创建 Reactor 的主线上。目前，Reactor 的核心 Selector 已经创建完成。之前提到，Reactor 除了需要监听 IO 就绪事件和处理这些事件外，还需要执行一些异步任务。当外部线程向 Reactor 提交异步任务时，Reactor 需要一个队列来保存这些任务，以便等待 Reactor 线程执行。

接下来，我们来看看 Reactor 中任务队列的创建过程：

```java
//任务队列大小，默认是无界队列
protected static final int DEFAULT_MAX_PENDING_TASKS = Math.max(16,
        SystemPropertyUtil.getInt("io.netty.eventLoop.maxPendingTasks", Integer.MAX_VALUE));

private static Queue<Runnable> newTaskQueue(
        EventLoopTaskQueueFactory queueFactory) {
    if (queueFactory == null) {
        return newTaskQueue0(DEFAULT_MAX_PENDING_TASKS);
    }
    return queueFactory.newTaskQueue(DEFAULT_MAX_PENDING_TASKS);
}

private static Queue<Runnable> newTaskQueue0(int maxPendingTasks) {
    // This event loop never calls takeTask()
    return maxPendingTasks == Integer.MAX_VALUE ? PlatformDependent.<Runnable>newMpscQueue()
            : PlatformDependent.<Runnable>newMpscQueue(maxPendingTasks);
}
```

- 在 `NioEventLoop` 的父类 `SingleThreadEventLoop` 中，提供了一个静态变量 `DEFAULT_MAX_PENDING_TASKS` 用于指定 Reactor 任务队列的大小。可以通过系统变量 `-D io.netty.eventLoop.maxPendingTasks` 进行设置，默认为 `Integer.MAX_VALUE`，这表示任务队列默认为无界队列。

  根据 `DEFAULT_MAX_PENDING_TASKS` 变量的设定，决定创建无界任务队列还是有界任务队列。

```java
//创建无界任务队列
PlatformDependent.<Runnable>newMpscQueue()
//创建有界任务队列
PlatformDependent.<Runnable>newMpscQueue(maxPendingTasks)

public static <T> Queue<T> newMpscQueue() {
    return Mpsc.newMpscQueue();
}

public static <T> Queue<T> newMpscQueue(final int maxCapacity) {
    return Mpsc.newMpscQueue(maxCapacity);
}
```

Reactor 内的异步任务队列类型为 `MpscQueue`，这是由 JCTools 提供的一个高性能无锁队列。根据命名前缀 `Mpsc`，我们可以看出它适用于多生产者单消费者的场景。该队列支持多个生产者线程安全地访问，同一时刻只允许一个消费者线程读取队列中的元素。

我们知道，Netty 中的 Reactor 能够线程安全地处理注册在其上的多个 `SocketChannel` 的 IO 数据，保证 Reactor 线程安全的核心原因正是因为这个 `MpscQueue`。它支持多个业务线程在处理完业务逻辑后，线程安全地向 `MpscQueue` 添加异步写任务，随后由单个 Reactor 线程来执行这些写任务。既然是单线程执行，那么其本身就具有线程安全性。【TODO】MpscQueue

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311534290.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031153415232" style="zoom:33%;" />

#### 3、创建 Channel 到 Reactor 的绑定策略

到这里，Reactor 线程组 `NioEventLoopGroup` 内的所有 Reactor 已经全部创建完成。

无论是 Netty 服务端的 `NioServerSocketChannel` 关注的 `OP_ACCEPT` 事件，还是 Netty 客户端的 `NioSocketChannel` 关注的 `OP_READ` 和 `OP_WRITE` 事件，都需要先注册到 Reactor 上，Reactor 才能监听 Channel 上关注的 IO 事件，从而实现 IO 多路复用。

由于 `NioEventLoopGroup`（Reactor 线程组）中有众多的 Reactor，那么这些 Channel 应该注册到哪个 Reactor 上呢？这就需要一个绑定策略来实现平均分配。

还记得我们之前介绍的 `MultithreadEventExecutorGroup` 类时提到的构造器参数 `EventExecutorChooserFactory` 吗？这时候它就派上用场了，主要用于创建 Channel 到 Reactor 的绑定策略。默认情况下，它的值为 `DefaultEventExecutorChooserFactory.INSTANCE`。

```java
public abstract class MultithreadEventExecutorGroup extends AbstractEventExecutorGroup {
   //从Reactor集合中选择一个特定的Reactor的绑定策略 用于channel注册绑定到一个固定的Reactor上
    private final EventExecutorChooserFactory.EventExecutorChooser chooser;

    protected MultithreadEventExecutorGroup(int nThreads, Executor executor,
                                            EventExecutorChooserFactory chooserFactory, Object... args) {
        。。。
        chooser = chooserFactory.newChooser(children);
        。。。
    }

}
```

下面我们来看下具体的绑定策略：

##### DefaultEventExecutorChooserFactory

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730004068243-49081d13-a0bf-4834-b02d-527b767de37c.png)

我们看到在 `newChooser` 方法中，绑定策略有两个分支，其不同之处在于需要判断 Reactor 线程组中的 Reactor 个数是否为 2 的次幂。

Netty 的绑定策略采用了 **round-robin** 轮询的方式来依次选择 Reactor 进行绑定。采用 round-robin 的方式进行负载均衡时，我们通常使用 `round % reactor.length` 的取余方式来平均定位到对应的 Reactor 上。

如果 Reactor 的个数 `reactor.length` 恰好是 2 的次幂，那么我们可以用位操作 `&` 运算 `round & (reactor.length - 1)` 来代替 `%` 运算 `round % reactor.length`，因为位运算的性能更高。具体而言，为什么 `&` 运算能够代替 `%` 运算，笔者将在后面讲述时间轮时为大家详细证明。此处大家只需记住这个公式，接下来我们聚焦于本文的主线。

了解了优化原理后，查看代码实现将变得更加容易理解。

**利用`%`运算的方式来进行绑定**

$$ \text{Math.abs}\left(\text{idx.getAndIncrement()}\mod \text{executors.length}\right) $$

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730004143315-7fddeb7b-080d-4ddd-ad7a-e2912289e653.png)

**利用`&`运算的方式来进行绑定。**

$$ \text{idx.getAndIncrement()} \& (\text{executors.length} - 1) $$

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730004136283-83fe0b50-4c59-49b0-ae4f-16ca4e30e6a9.png" alt="img" style="zoom:80%;" />

#### 4、向 Reactor 线程组中所有的 Reactor 注册 terminated 回调函数

当 Reactor 线程组 `NioEventLoopGroup` 中的所有 Reactor 已经创建完毕，且 Channel 到 Reactor 的绑定策略也已创建完成后，我们就进入了创建 `NioEventGroup` 的最后一步。

俗话说，有创建就有启动，有启动就有关闭。在这里，我们会创建 Reactor 关闭的回调函数 `terminationListener`，该回调函数将在 Reactor 关闭时触发。

`terminationListener` 回调的逻辑很简单：

- 通过 `AtomicInteger terminatedChildren` 变量记录已经关闭的 Reactor 个数，用于判断 `NioEventLoopGroup` 中的 Reactor 是否已全部关闭。
- 如果所有 Reactor 均已关闭，则设置 `NioEventLoopGroup` 中的 `terminationFuture` 为成功状态，表示 Reactor 线程组已成功关闭。

```java
//记录关闭的Reactor个数，当Reactor全部关闭后，才可以认为关闭成功
private final AtomicInteger terminatedChildren = new AtomicInteger();
//关闭future
private final Promise<?> terminationFuture = new DefaultPromise(GlobalEventExecutor.INSTANCE);

final FutureListener<Object> terminationListener = new FutureListener<Object>() {
    @Override
    public void operationComplete(Future<Object> future) throws Exception {
        if (terminatedChildren.incrementAndGet() == children.length) {
            //当所有Reactor关闭后 才认为是关闭成功
            terminationFuture.setSuccess(null);
        }
    }
};

//为所有Reactor添加terminationListener
for (EventExecutor e: children) {
    e.terminationFuture().addListener(terminationListener);
}
```

---

我们在回到文章开头给出的 Netty 服务端代码模板

```java
public final class EchoServer {
    static final int PORT = Integer.parseInt(System.getProperty("port", "8007"));

    public static void main(String[] args) throws Exception {
        // Configure the server.
        //创建主从Reactor线程组
        EventLoopGroup bossGroup = new NioEventLoopGroup(1);
        EventLoopGroup workerGroup = new NioEventLoopGroup();

        ...........省略............
    }
}
```

现在 Netty 的`主从Reactor线程组`就已经创建完毕，此时 Netty 服务端的骨架已经搭建完毕，骨架如下：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311534277.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,b_nw,x_1,y_1" alt="image-20241031153401184" style="zoom:33%;" />

## 总结

我们花了大量篇幅探讨了 Netty 服务端的核心引擎主从 Reactor 线程组的创建过程。在这个过程中，我们还提到了 Netty 对各种细节进行的优化，展现了其对性能极致追求的决心。

至此，Netty 服务端的骨架已经搭建完成，接下来的步骤是绑定端口地址以接收连接。我们下篇文章再见！
