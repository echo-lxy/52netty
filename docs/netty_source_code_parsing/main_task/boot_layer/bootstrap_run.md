# BootStrap 启动 Netty 服务

## 前言

还记得我们之前的模板吗 [EchoServer 代码模板](/netty_source_code_parsing/main_task/boot_layer/bootstrap_init.html#echoserver-代码模板)

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

当我们创建完成主从 ReactorGroup 之后，我们要开始启动这俩，怎么启动呢，我们这里有一个启动类ServerBootstrap，我们可以看看它的类注释

::: tip `ServerBootstrap` 源码中的类注释

`ServerBootstrap`是`Bootstrap` 的子类，提供了简化 `ServerChannel` 引导（启动）过程的方法。

:::

由此可见，`ServerBootstrap` 是 Netty 用于启动服务器的助手类。它提供了一系列流式方法，以配置服务器的网络层选项、线程模型和业务处理逻辑。通过 `ServerBootstrap`，用户可以轻松地设置服务器监听端口、初始化通道 (`Channel`) 以及绑定事件处理器等。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1729833767302-92f6240e-7c52-4beb-93da-a9e681e2534b.png" alt="img" style="zoom: 67%;" />

本文旨在从 `ServerBootstrap` 出发，探讨其如何成功启动 **Main Reactor Group**，并将程序的触发点移交给 Reactor 线程，同时绑定我们的 TCP 服务器监听端口（将 Channel 注册到主 Reactor 线程）。在这个过程中，Netty 还大量使用了基于 Future 和 Promise 的异步编排优化。【TODO】Future 和 Promise

## ServerBootstrap 的初始化

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1729650769078-976813b6-07e8-4ba3-9e3a-53ad4b0b962d.png" alt="img" style="zoom: 50%;" />

`ServerBootstrap` 的继承结构相对简单，职责分工也非常明确。

`ServerBootstrap` 主要负责管理主从 Reactor 线程组的相关配置。其中，以 `child` 前缀的方法用于配置从 Reactor 线程组的相关设置。从 Reactor 线程组中的 Sub Reactor 负责管理的客户端 `NioSocketChannel` 相关配置则存储在 `ServerBootstrap` 结构中。

其父类 `AbstractBootstrap` 主要负责管理主 Reactor 线程组的相关配置，以及主 Reactor 线程组中的 Main Reactor 处理的服务端 `ServerSocketChannel` 相关配置管理。

### 1、配置主从 Reactor 线程组

```java
ServerBootstrap b = new ServerBootstrap();
b.group(bossGroup, workerGroup) //配置主从Reactor
    
public class ServerBootstrap extends AbstractBootstrap<ServerBootstrap, ServerChannel> {

     // Main Reactor 线程组
    volatile EventLoopGroup group;
    //Sub Reactor线程组
    private volatile EventLoopGroup childGroup;

    public ServerBootstrap group(EventLoopGroup parentGroup, EventLoopGroup childGroup) {
        //父类管理主Reactor线程组
        super.group(parentGroup);
        if (this.childGroup != null) {
            throw new IllegalStateException("childGroup set already");
        }
        this.childGroup = ObjectUtil.checkNotNull(childGroup, "childGroup");
        return this;
    }

}
```

### 2、配置服务端 ServerSocketChannel

```java
ServerBootstrap b = new ServerBootstrap();
b.channel(NioServerSocketChannel.class);
public class ServerBootstrap extends AbstractBootstrap<ServerBootstrap, ServerChannel> {

    //用于创建 ServerSocketChannel ReflectiveChannelFactory
    private volatile ChannelFactory<? extends C> channelFactory;

    public B channel(Class<? extends C> channelClass) {
        return channelFactory(new ReflectiveChannelFactory<C>(
                ObjectUtil.checkNotNull(channelClass, "channelClass")
        ));
    }

    @Deprecated
    public B channelFactory(ChannelFactory<? extends C> channelFactory) {
        ObjectUtil.checkNotNull(channelFactory, "channelFactory");
        if (this.channelFactory != null) {
            throw new IllegalStateException("channelFactory set already");
        }

        this.channelFactory = channelFactory;
        return self();
    }

}
```

 在向 `ServerBootstrap` 配置服务端 `ServerSocketChannel` 的 `channel` 方法中，实际上是创建了一个 `ChannelFactory` 工厂实例 `ReflectiveChannelFactory`。在 Netty 服务端启动过程中，会通过这个 `ChannelFactory` 来创建相应的 `Channel` 实例。  

#### ReflectiveChannelFactory

```java
public class ReflectiveChannelFactory<T extends Channel> implements ChannelFactory<T> {
    //NioServerSocketChannelde 构造器
    private final Constructor<? extends T> constructor;

    public ReflectiveChannelFactory(Class<? extends T> clazz) {
        ObjectUtil.checkNotNull(clazz, "clazz");
        try {
            //反射获取NioServerSocketChannel的构造器
            this.constructor = clazz.getConstructor();
        } catch (NoSuchMethodException e) {
            throw new IllegalArgumentException("Class " + StringUtil.simpleClassName(clazz) +
                    " does not have a public non-arg constructor", e);
        }
    }

    @Override
    public T newChannel() {
        try {
            //创建NioServerSocketChannel实例
            return constructor.newInstance();
        } catch (Throwable t) {
            throw new ChannelException("Unable to create Channel from class " + constructor.getDeclaringClass(), t);
        }
    }
}
```

 从类的签名可以看出，这个工厂类是通过泛型和反射的方式来创建相应的 Channel 实例。  

### 3、为 NioServerSocketChannel 配置 ChannelOption

```java
ServerBootstrap b = new ServerBootstrap();
//设置被MainReactor管理的NioServerSocketChannel的Socket选项
b.option(ChannelOption.SO_BACKLOG, 100)
public abstract class AbstractBootstrap<B extends AbstractBootstrap<B, C>, C extends Channel> implements Cloneable {

    //serverSocketChannel中的ChannelOption配置
    private final Map<ChannelOption<?>, Object> options = new LinkedHashMap<ChannelOption<?>, Object>();

    public <T> B option(ChannelOption<T> option, T value) {
        ObjectUtil.checkNotNull(option, "option");
        synchronized (options) {
            if (value == null) {
                options.remove(option);
            } else {
                options.put(option, value);
            }
        }
        return self();
    }
}
```

无论是服务端的 `NioServerSocketChannel` 还是客户端的 `NioSocketChannel`，它们的相关底层 Socket 选项 `ChannelOption` 配置均存放于一个 `Map` 类型的数据结构中。

由于客户端 `NioSocketChannel` 是由从 Reactor 线程组中的 Sub Reactor 负责处理，因此涉及到客户端 `NioSocketChannel` 的所有方法和配置均以 `child` 前缀开头。

Netty 中的相关底层 Socket 选项全部枚举在 `ChannelOption` 类中，具体参数在此不一一列举。在本系列后续的文章中，我将为大家详细介绍这些参数的作用。

```java
public class ChannelOption<T> extends AbstractConstant<ChannelOption<T>> {

    ..................省略..............

    public static final ChannelOption<Boolean> SO_BROADCAST = valueOf("SO_BROADCAST");
    public static final ChannelOption<Boolean> SO_KEEPALIVE = valueOf("SO_KEEPALIVE");
    public static final ChannelOption<Integer> SO_SNDBUF = valueOf("SO_SNDBUF");
    public static final ChannelOption<Integer> SO_RCVBUF = valueOf("SO_RCVBUF");
    public static final ChannelOption<Boolean> SO_REUSEADDR = valueOf("SO_REUSEADDR");
    public static final ChannelOption<Integer> SO_LINGER = valueOf("SO_LINGER");
    public static final ChannelOption<Integer> SO_BACKLOG = valueOf("SO_BACKLOG");
    public static final ChannelOption<Integer> SO_TIMEOUT = valueOf("SO_TIMEOUT");

    ..................省略..............

}
```

### 4、为 NioServerSocketChannel 中的 Pipeline 配置 ChannelHandler

```java
//serverSocketChannel中pipeline里的handler(主要是acceptor)
private volatile ChannelHandler handler;

public B handler(ChannelHandler handler) {
    this.handler = ObjectUtil.checkNotNull(handler, "handler");
    return self();
}
```

## Netty 服务端的启动

### 概述

```java
// Start the server. 绑定端口启动服务，开始监听accept事件
ChannelFuture f = serverBootStrap.bind(PORT).sync();
```

经过前面的铺垫终于来到了本文的核心内容 -> Netty 服务端的启动过程。

如代码模板中的示例所示，Netty 服务端的启动过程封装在`io.netty.bootstrap.AbstractBootstrap#bind(int)`函数中。

**接下来我们看一下 Netty 服务端在启动过程中究竟干了哪些事情？**

![image-20241031154508926](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311545151.png)

我们先来从 Netty 服务端启动的入口函数 `bind` 开始我们今天的源码解析旅程：

```java
public ChannelFuture bind(int inetPort) {
    return bind(new InetSocketAddress(inetPort));
}

public ChannelFuture bind(SocketAddress localAddress) {
    //校验Netty核心组件是否配置齐全
    validate();
    //服务端开始启动，绑定端口地址，接收客户端连接
    return doBind(ObjectUtil.checkNotNull(localAddress, "localAddress"));
}

private ChannelFuture doBind(final SocketAddress localAddress) {
    //异步创建，初始化，注册ServerSocketChannel到main reactor上
    final ChannelFuture regFuture = initAndRegister();
    final Channel channel = regFuture.channel();
    if (regFuture.cause() != null) {
        return regFuture;
    }

    if (regFuture.isDone()) {   

       ........serverSocketChannel向Main Reactor注册成功后开始绑定端口....,               
         
    } else {
        //如果此时注册操作没有完成，则向regFuture添加operationComplete回调函数，注册成功后回调。
        regFuture.addListener(new ChannelFutureListener() {
            @Override
            public void operationComplete(ChannelFuture future) throws Exception {

               ........serverSocketChannel向Main Reactor注册成功后开始绑定端口...., 
        });
        return promise;
    }
}
```

**Netty服务端的启动流程总体如下：**

1. 创建并初始化服务端 `NioServerSocketChannel`。
2. 将服务端 `NioServerSocketChannel` 注册到主 Reactor 线程组中。
3. 注册成功后，开始初始化 `NioServerSocketChannel` 中的 pipeline，并在 pipeline 中触发 `channelRegister` 事件。
4. 随后，`NioServerSocketChannel` 绑定端口地址。
5. 绑定端口地址成功后，向 `NioServerSocketChannel` 对应的 pipeline 中触发传播 `ChannelActive` 事件。在 `ChannelActive` 事件回调中，向 Main Reactor 注册 `OP_ACCEPT` 事件，开始等待客户端连接。服务端启动完成。

::: tip

要先将创建出来的 Socket 绑定端口地址，再去 Selector 上注册其感兴趣的事件

:::

当 Netty 服务端启动成功之后，最终我们会得到如下结构的阵型，开始枕戈待旦，准备接收客户端的连接，Reactor 开始运转



![image-20241031154643597](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311546798.png)



我们接下来的任务就是要深入分析上述 `private ChannelFuture doBind(final SocketAddress localAddress)`方法，在必要时请回过头来查看其代码

### 1、initAndRegister

```java
final ChannelFuture initAndRegister() {
    Channel channel = null;
    try {
        //创建 NioServerSocketChannel
        //ReflectiveChannelFactory 通过泛型，反射，工厂的方式灵活创建不同类型的 channel
        channel = channelFactory.newChannel();
        //初始化NioServerSocketChannel
        init(channel);
    } catch (Throwable t) {
        ..............省略.................
    }

    //向MainReactor注册ServerSocketChannel
    ChannelFuture regFuture = config().group().register(channel);

       ..............省略.................

    return regFuture;
}
```

 从函数命名中可以看出，这个函数的主要任务是首先创建 `NioServerSocketChannel`，然后对其进行初始化，最后将 `NioServerSocketChannel` 注册到 Main Reactor 中。  

![image-20241031154745747](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311547797.png)

#### 创建 NioServerSocketChannel

```java
public class ReflectiveChannelFactory<T extends Channel> implements ChannelFactory<T> {

    private final Constructor<? extends T> constructor;

    @Override
    public T newChannel() {
        try {
            return constructor.newInstance();
        } catch (Throwable t) {
            throw new ChannelException("Unable to create Channel from class " + constructor.getDeclaringClass(), t);
        }
    }
}
```

##### NioServerSocketChannel

```java
public class NioServerSocketChannel extends AbstractNioMessageChannel
                             implements io.netty.channel.socket.ServerSocketChannel {

    //SelectorProvider(用于创建Selector和Selectable Channels)
    private static final SelectorProvider DEFAULT_SELECTOR_PROVIDER = SelectorProvider.provider();

    public NioServerSocketChannel() {
        this(newSocket(DEFAULT_SELECTOR_PROVIDER));
    }

    //创建JDK NIO ServerSocketChannel
    private static ServerSocketChannel newSocket(SelectorProvider provider) {
        try {
            return provider.openServerSocketChannel();
        } catch (IOException e) {
            throw new ChannelException(
                    "Failed to open a server socket.", e);
        }
    }

     //ServerSocketChannel相关的配置
    private final ServerSocketChannelConfig config;

    public NioServerSocketChannel(ServerSocketChannel channel) {
        //父类AbstractNioChannel中保存JDK NIO原生ServerSocketChannel以及要监听的事件OP_ACCEPT
        super(null, channel, SelectionKey.OP_ACCEPT);
        //DefaultChannelConfig中设置用于Channel接收数据用的buffer->AdaptiveRecvByteBufAllocator
        config = new NioServerSocketChannelConfig(this, javaChannel().socket());
    }

}
```

1. 首先调用 `newSocket` 创建 JDK NIO 原生 `ServerSocketChannel`，这一过程通过 `SelectorProvider#openServerSocketChannel` 实现。在[《BootStrap 初始化 Netty 服务》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_init)中，我们详细介绍了 `SelectorProvider` 相关内容，当时是用 `SelectorProvider` 来创建 Reactor 中的 `Selector`。
2. 通过父类构造器设置 `NioServerSocketChannel` 感兴趣的 IO 事件，这里设置的是 `SelectionKey.OP_ACCEPT` 事件，并将 JDK NIO 原生 `ServerSocketChannel` 封装起来。
3. 创建 Channel 的配置类 `NioServerSocketChannelConfig`，该配置类封装了对 Channel 底层的一些配置行为，以及 JDK 中的 `ServerSocket`。同时，创建用于接收数据的 `NioServerSocketChannel` 的缓冲区分配器 `AdaptiveRecvByteBufAllocator`。【TODO】AdaptiveRecvByteBufAllocator

##### AbstractNioChannel

```java
public abstract class AbstractNioChannel extends AbstractChannel {
   //JDK NIO 原生 Selectable Channel
    private final SelectableChannel ch;
    // Channel监听事件集合 这里是SelectionKey.OP_ACCEPT事件
    protected final int readInterestOp;

    protected AbstractNioChannel(Channel parent, SelectableChannel ch, int readInterestOp) {
        super(parent);
        this.ch = ch;
        this.readInterestOp = readInterestOp;
        try {
            //设置Channel为非阻塞 配合IO多路复用模型
            ch.configureBlocking(false);
        }catch (IOException e) {
            .............省略................
        }
    }
}
```

##### AbstractChannel

```java
public abstract class AbstractChannel extends DefaultAttributeMap implements Channel {

    //channel是由创建层次的，比如ServerSocketChannel 是 SocketChannel的 parent
    private final Channel parent;
    //channel全局唯一ID machineId+processId+sequence+timestamp+random
    private final ChannelId id;
    //unsafe用于封装对底层socket的相关操作
    private final Unsafe unsafe;
    //为channel分配独立的pipeline用于IO事件编排
    private final DefaultChannelPipeline pipeline;

    protected AbstractChannel(Channel parent) {
        this.parent = parent;
        //channel全局唯一ID machineId+processId+sequence+timestamp+random
        id = newId();
        //unsafe用于定义实现对Channel的底层操作
        unsafe = newUnsafe();
        //为channel分配独立的pipeline用于IO事件编排
        pipeline = newChannelPipeline();
    }
}
```

#### 初始化 NioServerSocketChannel

```java
void init(Channel channel) {
    //向NioServerSocketChannelConfig设置ServerSocketChannelOption
    setChannelOptions(channel, newOptionsArray(), logger);
    //向netty自定义的NioServerSocketChannel设置attributes
    setAttributes(channel, attrs0().entrySet().toArray(EMPTY_ATTRIBUTE_ARRAY));

    ChannelPipeline p = channel.pipeline();
    
    //获取从Reactor线程组
    final EventLoopGroup currentChildGroup = childGroup;
    //获取用于初始化客户端NioSocketChannel的ChannelInitializer
    final ChannelHandler currentChildHandler = childHandler;
    //获取用户配置的客户端SocketChannel的channelOption以及attributes
    final Entry<ChannelOption<?>, Object>[] currentChildOptions;
    synchronized (childOptions) {
        currentChildOptions = childOptions.entrySet().toArray(EMPTY_OPTION_ARRAY);
    }
    final Entry<AttributeKey<?>, Object>[] currentChildAttrs = childAttrs.entrySet().toArray(EMPTY_ATTRIBUTE_ARRAY);

    //向NioServerSocketChannel中的pipeline添加初始化ChannelHandler的逻辑
    p.addLast(new ChannelInitializer<Channel>() {
        @Override
        public void initChannel(final Channel ch) {
            final ChannelPipeline pipeline = ch.pipeline();
            //ServerBootstrap中用户指定的channelHandler
            ChannelHandler handler = config.handler();
            if (handler != null) {
                //LoggingHandler
                pipeline.addLast(handler);
            }
            //添加用于接收客户端连接的acceptor
            ch.eventLoop().execute(new Runnable() {
                @Override
                public void run() {
                    pipeline.addLast(new ServerBootstrapAcceptor(
                            ch, currentChildGroup, currentChildHandler, currentChildOptions, currentChildAttrs));
                }
            });
        }
    });
}
```

1. 向 `NioServerSocketChannelConfig` 设置 `ServerSocketChannelOption`
2. 向 Netty 自定义的 `NioServerSocketChannel` 设置 `ChannelAttributes`
3. 获取从 Reactor 线程组 `childGroup`，以及用于初始化客户端 `NioSocketChannel` 的 `ChannelInitializer`、`ChannelOption` 和 `ChannelAttributes`。这些信息均是用户在启动时向 `ServerBootstrap` 添加的客户端 `NioServerChannel` 配置信息。这里使用这些信息来初始化 `ServerBootstrapAcceptor`，因为后续会在 `ServerBootstrapAcceptor` 中接收客户端连接并创建 `NioServerChannel`
4. 向 `NioServerSocketChannel` 中的 pipeline 添加用于初始化 pipeline 的 `ChannelInitializer`

#### 向 Main Reactor 注册 NioServerSocketChannel

从 从 `ServerBootstrap` 获取主 Reactor 线程组 `NioEventLoopGroup`，并将 `NioServerSocketChannel` 注册到 `NioEventLoopGroup` 中。  

```java
ChannelFuture regFuture = config().group().register(channel);
```

下面我们来看下具体的注册过程：

##### 主 Reactor 线程组中选取一个 Main Reactor 进行注册

```java
@Override
public ChannelFuture register(Channel channel) {
    return next().register(channel);
}

@Override
public EventExecutor next() {
    return chooser.next();
}

//获取绑定策略
@Override
public EventExecutorChooser newChooser(EventExecutor[] executors) {
    if (isPowerOfTwo(executors.length)) {
        return new PowerOfTwoEventExecutorChooser(executors);
    } else {
        return new GenericEventExecutorChooser(executors);
    }
}

//采用轮询round-robin的方式选择Reactor
@Override
public EventExecutor next() {
    return executors[(int) Math.abs(idx.getAndIncrement() % executors.length)];
}
```

这个绑定策略在[《BootStrap 初始化 Netty 服务》](/netty_source_code_parsing/main_task/boot_layer/bootstrap_init)中有提及

##### 向绑定后的 Main Reactor 进行注册

```java
public abstract class SingleThreadEventLoop extends SingleThreadEventExecutor implements EventLoop {

    @Override
    public ChannelFuture register(Channel channel) {
        //注册channel到绑定的Reactor上
        return register(new DefaultChannelPromise(channel, this));
    }

    @Override
    public ChannelFuture register(final ChannelPromise promise) {
        ObjectUtil.checkNotNull(promise, "promise");
        //unsafe负责channel底层的各种操作
        promise.channel().unsafe().register(this, promise);
        return promise;
    }
    
}
protected abstract class AbstractUnsafe implements Unsafe {

    /**
     * 注册Channel到绑定的Reactor上
     * */
    @Override
    public final void register(EventLoop eventLoop, final ChannelPromise promise) {
        ObjectUtil.checkNotNull(eventLoop, "eventLoop");
        if (isRegistered()) {
            promise.setFailure(new IllegalStateException("registered to an event loop already"));
            return;
        }
        //EventLoop的类型要与Channel的类型一样  Nio Oio Aio
        if (!isCompatible(eventLoop)) {
            promise.setFailure(
                    new IllegalStateException("incompatible event loop type: " + eventLoop.getClass().getName()));
            return;
        }

        //在channel上设置绑定的Reactor
        AbstractChannel.this.eventLoop = eventLoop;

        /**
         * 执行channel注册的操作必须是Reactor线程来完成
         *
         * 1: 如果当前执行线程是Reactor线程，则直接执行register0进行注册
         * 2：如果当前执行线程是外部线程，则需要将register0注册操作 封装程异步Task 由Reactor线程执行
         * */
        if (eventLoop.inEventLoop()) {
            register0(promise);
        } else {
            try {
                eventLoop.execute(new Runnable() {
                    @Override
                    public void run() {
                        register0(promise);
                    }
                });
            } catch (Throwable t) {
               ...............省略...............
            }
        }
    }
}
```

1. 首先检查 `NioServerSocketChannel` 是否已经完成注册。如果已完成注册，则直接将代表注册操作结果的 `ChannelPromise` 设置为失败状态。

2. 通过 `isCompatible` 方法验证 Reactor 模型 `EventLoop` 是否与 Channel 的类型匹配。`NioEventLoop` 对应于 `NioServerSocketChannel`。

3. 在 Channel 中保存其绑定的 Reactor 实例。

4. 执行 Channel 向 Reactor 注册的操作时，必须确保在 Reactor 线程中执行：

   - 如果当前线程是 Reactor 线程，则直接执行注册动作 `register0`。

   - 如果当前线程不是 Reactor 线程，则需要将注册动作 `register0` 封装成异步任务，存放在 Reactor 中的 `taskQueue` 中，等待 Reactor 线程执行。

当前执行线程不是 Reactor 线程，而是用户程序的启动线程，即 Main 线程。

##### Reactor 线程的启动

在上篇文章中，我们介绍了 `NioEventLoopGroup` 的创建过程，提到一个构造器参数 `executor`，它用于启动 Reactor 线程，类型为 `ThreadPerTaskExecutor`。

当时我向大家抛出了一个悬念：**“Reactor 线程是何时启动的？”**

现在是揭晓谜底的时候了~~
Reactor 线程的启动是在向 Reactor 提交第一个异步任务时触发的。

```java
eventLoop.execute(new Runnable() {
    @Override
    public void run() {
        register0(promise);
    }
});
```

接下来，我们关注 `NioEventLoop` 的 `execute` 方法

```java
public abstract class SingleThreadEventExecutor extends AbstractScheduledEventExecutor implements OrderedEventExecutor {

    @Override
    public void execute(Runnable task) {
        ObjectUtil.checkNotNull(task, "task");
        execute(task, !(task instanceof LazyRunnable) && wakesUpForTask(task));
    }

    private void execute(Runnable task, boolean immediate) {
        //当前线程是否为Reactor线程
        boolean inEventLoop = inEventLoop();
        //addTaskWakesUp = true  addTask唤醒Reactor线程执行任务
        addTask(task);
        if (!inEventLoop) {
            //如果当前线程不是Reactor线程，则启动Reactor线程
            //这里可以看出Reactor线程的启动是通过 向NioEventLoop添加异步任务时启动的
            startThread();

            .....................省略.....................
        }
        .....................省略.....................
    }

}
```

1. 首先，将异步任务 `task` 添加到 Reactor 中的 `taskQueue` 中。
2. 判断当前线程是否为 Reactor 线程。此时，当前执行线程为用户程序的启动线程，因此在这里调用 `startThread` 启动 Reactor 线程。

##### startThread

```java
public abstract class SingleThreadEventExecutor extends AbstractScheduledEventExecutor implements OrderedEventExecutor {
    //定义Reactor线程状态
    private static final int ST_NOT_STARTED = 1;
    private static final int ST_STARTED = 2;
    private static final int ST_SHUTTING_DOWN = 3;
    private static final int ST_SHUTDOWN = 4;
    private static final int ST_TERMINATED = 5;

     //Reactor线程状态  初始为 未启动状态
    private volatile int state = ST_NOT_STARTED;

    //Reactor线程状态字段state 原子更新器
    private static final AtomicIntegerFieldUpdater<SingleThreadEventExecutor> STATE_UPDATER =
    AtomicIntegerFieldUpdater.newUpdater(SingleThreadEventExecutor.class, "state");

    private void startThread() {
        if (state == ST_NOT_STARTED) {
            if (STATE_UPDATER.compareAndSet(this, ST_NOT_STARTED, ST_STARTED)) {
                boolean success = false;
                try {
                    doStartThread();
                    success = true;
                } finally {
                    if (!success) {
                        STATE_UPDATER.compareAndSet(this, ST_STARTED, ST_NOT_STARTED);
                    }
                }
            }
        }
    }

}
```

1. Reactor 线程的初始化状态为 `ST_NOT_STARTED`，首先使用 CAS 更新状态为 `ST_STARTED`。
2. 调用 `doStartThread` 启动 Reactor 线程。
3. 如果启动失败，需要将 Reactor 线程的状态改回 `ST_NOT_STARTED`。

```java
//ThreadPerTaskExecutor 用于启动Reactor线程
private final Executor executor;

private void doStartThread() {
    assert thread == null;
    executor.execute(new Runnable() {
        @Override
        public void run() {
            thread = Thread.currentThread();
            if (interrupted) {
                thread.interrupt();
            }

            boolean success = false;
            updateLastExecutionTime();
            try {
                //Reactor线程开始启动
                SingleThreadEventExecutor.this.run();
                success = true;
            }
          
            ................省略..............
    }
}
```

4. 将 `NioEventLoop#run` 封装在异步任务中，并提交给 `executor` 执行，Reactor 线程至此开始工作了。  

这里正是 `ThreadPerTaskExecutor` 类型的 `executor` 发挥作用的时刻。

- Reactor 线程的核心工作之前已经介绍过：轮询所有注册在其上的 Channel 中的 IO 就绪事件，处理对应 Channel 上的 IO 事件，并执行异步任务。Netty 将这些核心工作封装在 `io.netty.channel.nio.NioEventLoop#run` 方法中。

![image-20241031155333787](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311553847.png)

这里可能有点绕，我来给大家捋一捋。还记得我们之前创建 NioEventLoop传入的Executor吗

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730007183814-ceab226e-427f-4589-a0e6-57b21f97dc20.png)

此 `ThreadPerTaskExecutor` 就是个很单纯的线程池

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730007264753-07130959-3122-4d43-9917-2ee5aaed9699.png)

在 `doStartThread()` 方法中，我们使用此 **executor** 去创建 **Reactor** 线程。之所以使用此 **executor**，笔者认为这体现了简单的代码复用和封装原则。

此时，**Reactor** 线程已经启动，**后续的工作全部由这个 Reactor 线程来负责执行**。

用户启动线程在向 **Reactor** 提交完 `NioServerSocketChannel` 的注册任务 `register0` 后，逐步退出调用堆栈，回退到最初的启动入口处：`ChannelFuture f = b.bind(PORT).sync()`。

此时，**Reactor** 中的任务队列中只有一个任务 `register0`。**Reactor** 线程启动后，将从任务队列中取出该任务进行执行。

![image-20241031155433032](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311554111.png)

 至此，`NioServerSocketChannel` 的注册工作正式拉开帷幕~~  

##### register0

```java
//true if the channel has never been registered, false otherwise 
private boolean neverRegistered = true;

private void register0(ChannelPromise promise) {
    try {
        //查看注册操作是否已经取消，或者对应channel已经关闭
        if (!promise.setUncancellable() || !ensureOpen(promise)) {
            return;
        }
        boolean firstRegistration = neverRegistered;
        //执行真正的注册操作
        doRegister();
        //修改注册状态
        neverRegistered = false;
        registered = true;
        //回调pipeline中添加的ChannelInitializer的handlerAdded方法，在这里初始化channelPipeline
        pipeline.invokeHandlerAddedIfNeeded();
        //设置regFuture为success，触发operationComplete回调,将bind操作放入Reactor的任务队列中，等待Reactor线程执行。
        safeSetSuccess(promise);
        //触发channelRegister事件
        pipeline.fireChannelRegistered();
        //对于服务端ServerSocketChannel来说 只有绑定端口地址成功后 channel的状态才是active的。
        //此时绑定操作作为异步任务在Reactor的任务队列中，绑定操作还没开始，所以这里的isActive()是false
        if (isActive()) {
            if (firstRegistration) {
                //触发channelActive事件
                pipeline.fireChannelActive();
            } else if (config().isAutoRead()) {
                beginRead();
            }
        }
    } catch (Throwable t) {
         ............省略.............
    }
}
```

`register0` 是驱动整个 Channel 注册绑定流程的关键方法，下面我们来看一下它的核心逻辑：

1. 首先检查 Channel 的注册动作是否在 Reactor 线程外被取消了：`promise.setUncancellable()`。然后检查要注册的 Channel 是否已经关闭：`ensureOpen(promise)`。如果 Channel 已关闭或注册操作已被取消，则直接返回，停止注册流程。
2. 调用 `doRegister()` 方法，执行真正的注册操作。此操作最终在 `AbstractChannel` 的子类 `AbstractNioChannel` 中实现，具体实现稍后介绍，我们先关注整体流程。
3. 当 Channel 向 Reactor 注册完毕后，调用 `pipeline.invokeHandlerAddedIfNeeded()` 方法，触发回调 pipeline 中添加的 `ChannelInitializer` 的 `handlerAdded` 方法。在 `handlerAdded` 方法中，利用前面提到的 `ChannelInitializer` 初始化 `ChannelPipeline`。
4. 设置 `regFuture` 为成功，并回调注册在 `regFuture` 上的 `ChannelFutureListener#operationComplete` 方法。在 `operationComplete` 回调方法中，将绑定操作封装成异步任务，提交到 Reactor 的 `taskQueue` 中，等待 Reactor 执行。
5. 通过 `pipeline.fireChannelRegistered()` 在 pipeline 中触发 `channelRegister` 事件。
6. 对于 Netty 服务端 `NioServerSocketChannel` 来说，只有在绑定端口地址成功后，Channel 的状态才会变为 active。此时，绑定操作在 `regFuture` 上注册的 `ChannelFutureListener#operationComplete` 回调方法被作为异步任务提交到 Reactor 的任务队列中，但 Reactor 线程尚未开始执行绑定任务。因此，此时 `isActive()` 的返回值是 `false`。

##### doRegister()

```java
public abstract class AbstractNioChannel extends AbstractChannel {

    //channel注册到Selector后获得的SelectKey
    volatile SelectionKey selectionKey;

    @Override
    protected void doRegister() throws Exception {
        boolean selected = false;
        for (;;) {
            try {
                selectionKey = javaChannel().register(eventLoop().unwrappedSelector(), 0, this);
                return;
            } catch (CancelledKeyException e) {
                ...............省略....................
            }
        }
    }

}
```

调用底层 JDK NIO Channel 方法 `java.nio.channels.SelectableChannel#register(java.nio.channels.Selector, int, java.lang.Object)`，将 `NettyNioServerSocketChannel` 中包装的 JDK NIO `ServerSocketChannel` 注册到 Reactor 中的 JDK NIO `Selector` 上。

下面简单介绍 `SelectableChannel#register` 方法参数的含义：

- **Selector**：表示 JDK NIO Channel 将要注册到哪个 Selector 上。
- **int ops**：表示 Channel 上感兴趣的 IO 事件。当对应的 IO 事件就绪时，Selector 会返回 Channel 对应的 `SelectionKey`。
- **Object attachment**：向 `SelectionKey` 中添加用户自定义的附加对象。

##### HandlerAdded 事件回调中初始化 ChannelPipeline

当 `NioServerSocketChannel` 注册到 Main Reactor 上的 Selector 后，Netty 通过调用 `pipeline.invokeHandlerAddedIfNeeded()` 开始回调 `NioServerSocketChannel` 中 pipeline 里的 `ChannelHandler` 的 `handlerAdded` 方法。

此时，`NioServerSocketChannel` 的 pipeline 结构如下：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301553525.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241030155306451" style="zoom:50%;" />

```java
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

    //ChannelInitializer实例是被所有的Channel共享的，用于初始化ChannelPipeline
    //通过Set集合保存已经初始化的ChannelPipeline，避免重复初始化同一ChannelPipeline
    private final Set<ChannelHandlerContext> initMap = Collections.newSetFromMap(
            new ConcurrentHashMap<ChannelHandlerContext, Boolean>());

    private boolean initChannel(ChannelHandlerContext ctx) throws Exception {
        if (initMap.add(ctx)) { // Guard against re-entrance.
            try {
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

    //匿名类实现，这里指定具体的初始化逻辑
    protected abstract void initChannel(C ch) throws Exception;

    private void removeState(final ChannelHandlerContext ctx) {
        //从initMap防重Set集合中删除ChannelInitializer
        if (ctx.isRemoved()) {
            initMap.remove(ctx);
        } else {
            ctx.executor().execute(new Runnable() {
                @Override
                public void run() {
                    initMap.remove(ctx);
                }
            });
        }
    }
}
```

`ChannelInitializer` 中的初始化逻辑比较简单明了：

- 首先要判断当前 Channel 是否已经完成注册，只有在注册完成后，才能进行 pipeline 的初始化。通过 `ctx.channel().isRegistered()` 进行判断。
- 调用 `ChannelInitializer` 的匿名类指定的 `initChannel` 方法，执行自定义的初始化逻辑。

```java
p.addLast(new ChannelInitializer<Channel>() {
    @Override
    public void initChannel(final Channel ch) {
        final ChannelPipeline pipeline = ch.pipeline();
        //ServerBootstrap中用户指定的channelHandler
        ChannelHandler handler = config.handler();
        if (handler != null) {
            pipeline.addLast(handler);
        }

        ch.eventLoop().execute(new Runnable() {
            @Override
            public void run() {
                pipeline.addLast(new ServerBootstrapAcceptor(
                        ch, currentChildGroup, currentChildHandler, currentChildOptions, currentChildAttrs));
            }
        });
    }
});
```

还记得在初始化 `NioServerSocketChannel` 时，`io.netty.bootstrap.ServerBootstrap#init` 方法中向 pipeline 中添加的 `ChannelInitializer` 吗？

- 当执行完 `initChannel` 方法后，ChannelPipeline 的初始化就结束了，此时 `ChannelInitializer` 就不再需要继续留在 pipeline 中，因此需要将 `ChannelInitializer` 从 pipeline 中删除：`pipeline.remove(this)`。

- 在初始化完 pipeline 后，pipeline 的结构再次发生变化：

  <img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301551474.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241030155155398" style="zoom:50%;" />

- 此时`Main Reactor`中的任务队列`taskQueue`结构变化为：

![image-20241031155545425](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311555526.png)

添加`ServerBootstrapAcceptor`的任务是在初始化`NioServerSocketChannel`的时候向main reactor提交过去的。还记得吗？

##### 回调regFuture的ChannelFutureListener

在本小节《Netty 服务端的启动》的最开始，我们介绍了服务端启动的入口函数 `io.netty.bootstrap.AbstractBootstrap#doBind`。在函数的最开头调用了 `initAndRegister()` 方法，用来创建并初始化 `NioServerSocketChannel`，随后将 `NioServerSocketChannel` 注册到 Main Reactor 中。

注册操作是一个异步的过程，因此在 `initAndRegister()` 方法调用后，会返回一个代表注册结果的 `ChannelFuture regFuture`。

```java
public abstract class AbstractBootstrap<B extends AbstractBootstrap<B, C>, C extends Channel> implements Cloneable {

    private ChannelFuture doBind(final SocketAddress localAddress) {
        //异步创建，初始化，注册ServerSocketChannel
        final ChannelFuture regFuture = initAndRegister();
        final Channel channel = regFuture.channel();
        if (regFuture.cause() != null) {
            return regFuture;
        }

        if (regFuture.isDone()) {
            //如果注册完成，则进行绑定操作
            ChannelPromise promise = channel.newPromise();
            doBind0(regFuture, channel, localAddress, promise);
            return promise;
        } else {
            final PendingRegistrationPromise promise = new PendingRegistrationPromise(channel);
            //添加注册完成 回调函数
            regFuture.addListener(new ChannelFutureListener() {
                @Override
                public void operationComplete(ChannelFuture future) throws Exception {

                         ...............省略...............
                          // 注册完成后，Reactor线程回调这里
                        doBind0(regFuture, channel, localAddress, promise);
                    }
                }
            });
            return promise;
        }
    }
}
```

之后，会向 `ChannelFuture regFuture` 添加一个注册完成后的回调函数 `ChannelFutureListener`。在回调函数 `operationComplete` 中，开始发起绑定端口地址的流程。

**那么，这个回调函数在什么时候、什么地方发起的呢？**

让我们回到本小节的主题，`register0` 方法的流程中：

- 当调用 `doRegister()` 方法完成 `NioServerSocketChannel` 向 Main Reactor 的注册后，紧接着会调用 `pipeline.invokeHandlerAddedIfNeeded()` 方法，触发 `ChannelInitializer#handlerAdded` 回调，对 pipeline 进行初始化。
- 最后，在 `safeSetSuccess` 方法中，开始回调注册在 `regFuture` 上的 `ChannelFutureListener`。

```java
protected final void safeSetSuccess(ChannelPromise promise) {
    if (!(promise instanceof VoidChannelPromise) && !promise.trySuccess()) {
       logger.warn("Failed to mark a promise as success because it is done already: {}", promise);
    }
}

@Override
public boolean trySuccess() {
    return trySuccess(null);
}

@Override
public boolean trySuccess(V result) {
    return setSuccess0(result);
}

private boolean setSuccess0(V result) {
    return setValue0(result == null ? SUCCESS : result);
}

private boolean setValue0(Object objResult) {
    if (RESULT_UPDATER.compareAndSet(this, null, objResult) ||
        RESULT_UPDATER.compareAndSet(this, UNCANCELLABLE, objResult)) {
        if (checkNotifyWaiters()) {
            //回调注册在promise上的listeners
            notifyListeners();
        }
        return true;
    }
    return false;
}
```

`safeSetSuccess`的逻辑比较简单，首先设置`regFuture`结果为`success`，并且回调注册在`regFuture`上的`ChannelFutureListener`。

### 2、doBind0

```java
public abstract class AbstractBootstrap<B extends AbstractBootstrap<B, C>, C extends Channel> implements Cloneable {

    private static void doBind0(
            final ChannelFuture regFuture, final Channel channel,
            final SocketAddress localAddress, final ChannelPromise promise) {

        channel.eventLoop().execute(new Runnable() {
            @Override
            public void run() {
                if (regFuture.isSuccess()) {
                    channel.bind(localAddress, promise).addListener(ChannelFutureListener.CLOSE_ON_FAILURE);
                } else {
                    promise.setFailure(regFuture.cause());
                }
            }
        });
    }

}
```

这里 Netty 将绑定端口地址的操作封装成异步任务，提交给 Reactor 执行。

但这里有一个问题：此时执行 `doBind0` 方法的线程正是 Reactor 线程，为什么不直接在这里执行 bind 操作，而是再次封装成异步任务提交给 Reactor 中的 `taskQueue` 呢？反正最终都是由 Reactor 线程执行，这其中有什么区别呢？

经过上小节的介绍，我们知道 `bind0` 方法的调用是由 `io.netty.channel.AbstractChannel.AbstractUnsafe#register0` 方法在将 `NioServerSocketChannel` 注册到 Main Reactor 之后，并且 `NioServerSocketChannel` 的 pipeline 已经初始化完毕后，通过 `safeSetSuccess` 方法回调过来的。

这个过程全程是由 Reactor 线程来负责执行的，但此时 `register0` 方法并没有执行完毕，还需要执行后面的逻辑。**而绑定逻辑需要在注册逻辑执行完之后执行**，因此在 `doBind0` 方法中，Reactor 线程会将绑定操作封装成异步任务，先提交给 `taskQueue` 中保存。这样可以使 Reactor 线程立刻从 `safeSetSuccess` 中返回，继续执行剩下的 `register0` 方法逻辑。

```java
private void register0(ChannelPromise promise) {
    try {
        ................省略............

        doRegister();
        pipeline.invokeHandlerAddedIfNeeded();
        safeSetSuccess(promise);
        //触发channelRegister事件
        pipeline.fireChannelRegistered();

        if (isActive()) {
             ................省略............
        }
    } catch (Throwable t) {
          ................省略............
    }
}
```

当`Reactor线程`执行完`register0`方法后，就会从`taskQueue`中取出异步任务执行。

此时`Reactor线程`中的`taskQueue`结构如下：

![image-20241031155545425](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311555526.png)

Reactor 线程会先取出位于 `taskQueue` 队首的任务执行，这里是指向 `NioServerSocketChannel` 的 pipeline 中添加 `ServerBootstrapAcceptor` 的异步任务。

此时 `NioServerSocketChannel` 中 pipeline 的结构如下：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301551727.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241030155116656" style="zoom:50%;" />

`Reactor线程`执行绑定任务。

### 3、绑定端口地址

对`Channel`的操作行为全部定义在`ChannelOutboundInvoker接口中`。

![image-20241031155724333](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311557395.png)

```java
public interface ChannelOutboundInvoker {

    /**
     * Request to bind to the given {@link SocketAddress} and notify the {@link ChannelFuture} once the operation
     * completes, either because the operation was successful or because of an error.
     *
     */
    ChannelFuture bind(SocketAddress localAddress, ChannelPromise promise);
}
```

`bind`方法由子类`AbstractChannel`实现。

```java
public abstract class AbstractChannel extends DefaultAttributeMap implements Channel {

   @Override
    public ChannelFuture bind(SocketAddress localAddress, ChannelPromise promise) {
        return pipeline.bind(localAddress, promise);
    }

}
```

调用 `pipeline.bind(localAddress, promise)` 在 pipeline 中传播 bind 事件，触发回调 pipeline 中所有 `ChannelHandler` 的 bind 方法。事件在 pipeline 中的传播具有方向性：

- **inbound 事件**：从 `HeadContext` 开始，逐个向后传播直到 `TailContext`。
- **outbound 事件**：反向传播，从 `TailContext` 开始，反向向前传播直到 `HeadContext`。

然而，这里的 bind 事件在 Netty 中被定义为 **outbound 事件**，因此它在 pipeline 中是反向传播的。这个过程先从 `TailContext` 开始反向传播，直到 `HeadContext`。

bind 的核心逻辑也正是实现在 `HeadContext` 中。

#### HeadContext

```java
final class HeadContext extends AbstractChannelHandlerContext
        implements ChannelOutboundHandler, ChannelInboundHandler {

 @Override
    public void bind(
            ChannelHandlerContext ctx, SocketAddress localAddress, ChannelPromise promise) {
        //触发AbstractChannel->bind方法 执行JDK NIO SelectableChannel 执行底层绑定操作
        unsafe.bind(localAddress, promise);
    }

}
```

在`HeadContext#bind`回调方法中，调用`Channel`里的`unsafe`操作类执行真正的绑定操作。

```java
protected abstract class AbstractUnsafe implements Unsafe {

    @Override
    public final void bind(final SocketAddress localAddress, final ChannelPromise promise) {
        .................省略................

        //这时channel还未激活  wasActive = false
        boolean wasActive = isActive();
        try {
            //io.netty.channel.socket.nio.NioServerSocketChannel.doBind
            //调用具体channel实现类
            doBind(localAddress);
        } catch (Throwable t) {
            .................省略................
            return;
        }

        //绑定成功后 channel激活 触发channelActive事件传播
        if (!wasActive && isActive()) {
            invokeLater(new Runnable() {
                @Override
                public void run() {
                    //pipeline中触发channelActive事件
                    pipeline.fireChannelActive();
                }
            });
        }
        //回调注册在promise上的ChannelFutureListener
        safeSetSuccess(promise);
    }

    protected abstract void doBind(SocketAddress localAddress) throws Exception;
}
```

- 首先执行子类`NioServerSocketChannel`具体实现的`doBind`方法，通过`JDK NIO 原生 ServerSocketChannel`执行底层的绑定操作。

```java
@Override
protected void doBind(SocketAddress localAddress) throws Exception {
    //调用JDK NIO 底层SelectableChannel 执行绑定操作
    if (PlatformDependent.javaVersion() >= 7) {
        javaChannel().bind(localAddress, config.getBacklog());
    } else {
        javaChannel().socket().bind(localAddress, config.getBacklog());
    }
}
```

- 判断是否为首次绑定。如果是的话，将触发 pipeline 中的 `ChannelActive` 事件，封装成异步任务，放入 Reactor 的 `taskQueue` 中。
- 执行 `safeSetSuccess(promise)`，并回调注册在 promise 上的 `ChannelFutureListener`。

**同样的问题，当前执行线程已经是 Reactor 线程，为什么不直接触发 pipeline 中的** `ChannelActive` **事件，而是又封装成异步任务呢？**

因为如果直接在这里触发 `ChannelActive` 事件，Reactor 线程就会执行 pipeline 中的 `ChannelHandler` 的 `channelActive` 事件回调。这将影响 `safeSetSuccess(promise)` 的执行，延迟注册在 promise 上的 `ChannelFutureListener` 的回调。

到目前为止，Netty 服务端已经完成了绑定端口地址的操作，`NioServerSocketChannel` 的状态现在变为 Active。

最后，还有一件重要的事情要做，我们接着来看 pipeline 中对 `channelActive` 事件的处理。

#### channelActive 事件处理

`channelActive` 事件在 Netty 中定义为 inbound 事件，因此它在 pipeline 中的传播为正向传播，从 `HeadContext` 一直到 `TailContext`。

在 `channelActive` 事件的回调中，需要触发向 Selector 指定需要监听的 IO 事件，即 `OP_ACCEPT` 事件。这部分的逻辑主要在 `HeadContext` 中实现。

```java
final class HeadContext extends AbstractChannelHandlerContext
        implements ChannelOutboundHandler, ChannelInboundHandler {

    @Override
    public void channelActive(ChannelHandlerContext ctx) {
        //pipeline中继续向后传播channelActive事件
        ctx.fireChannelActive();
        //如果是autoRead 则自动触发read事件传播
        //在read回调函数中 触发OP_ACCEPT注册
        readIfIsAutoRead();
    }

    private void readIfIsAutoRead() {
        if (channel.config().isAutoRead()) {
            //如果是autoRead 则触发read事件传播
            channel.read();
        }
    }

    //AbstractChannel
    public Channel read() {
            //触发read事件
            pipeline.read();
            return this;
    }

   @Override
    public void read(ChannelHandlerContext ctx) {
        //触发注册OP_ACCEPT或者OP_READ事件
        unsafe.beginRead();
    }
}
```

- 在 `HeadContext` 中的 `channelActive` 回调中，触发 pipeline 中的 `read` 事件。
- 当 `read` 事件再次传播到 `HeadContext` 时，触发 `HeadContext#read` 方法的回调。在 `read` 回调中，调用 channel 底层操作类 `unsafe` 的 `beginRead` 方法，以向 selector 注册监听 `OP_ACCEPT` 事件。

#### beginRead

```java
protected abstract class AbstractUnsafe implements Unsafe {

     @Override
        public final void beginRead() {
            assertEventLoop();
            //channel必须是Active
            if (!isActive()) {
                return;
            }

            try {
                // 触发在selector上注册channel感兴趣的监听事件
                doBeginRead();
            } catch (final Exception e) {
               .............省略..............
            }
        }
}

public abstract class AbstractChannel extends DefaultAttributeMap implements Channel {
    //子类负责继承实现
    protected abstract void doBeginRead() throws Exception;

}
```

- 断言判断执行该方法的线程必须是 Reactor 线程。
- 此时，`NioServerSocketChannel` 已经完成端口地址的绑定操作，`isActive() = true`。
- 调用 `doBeginRead` 实现向 Selector 注册监听事件 `OP_ACCEPT`。

```java
public abstract class AbstractNioChannel extends AbstractChannel {

    //channel注册到Selector后获得的SelectKey
    volatile SelectionKey selectionKey;
    // Channel监听事件集合
    protected final int readInterestOp;

    @Override
    protected void doBeginRead() throws Exception {
      
        final SelectionKey selectionKey = this.selectionKey;
        if (!selectionKey.isValid()) {
            return;
        }

        readPending = true;

        final int interestOps = selectionKey.interestOps();
        /**
         * 1：ServerSocketChannel 初始化时 readInterestOp设置的是OP_ACCEPT事件
         * */
        if ((interestOps & readInterestOp) == 0) {
            //添加OP_ACCEPT事件到interestOps集合中
            selectionKey.interestOps(interestOps | readInterestOp);
        }
    }
}
```

- 前面提到，在 `NioServerSocketChannel` 向 Main Reactor 中的 Selector 注册后，会获得一个 `SelectionKey`。这里首先要获取这个 `SelectionKey`。
- 从 `SelectionKey` 中获取 `NioServerSocketChannel` 感兴趣的 IO 事件集合 `interestOps`。注意，在注册时，`interestOps` 设置为 0。
- 将在 `NioServerSocketChannel` 初始化时设置的 `readInterestOp = OP_ACCEPT`，设置到 `SelectionKey` 中的 `interestOps` 集合中。这样，Reactor 中的 Selector 就开始监听 `interestOps` 集合中包含的 IO 事件了。

`Main Reactor`中主要监听的是`OP_ACCEPT事件`。

流程走到这里，Netty 服务端就真正的启动起来了，下一步就开始等待接收客户端连接了。大家此刻在来回看这副启动流程图，是不是清晰了很多呢？

![image-20241031154508926](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311545151.png)

此时Netty的`Reactor模型`结构如下：

![image-20241031154643597](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311546798.png)

## 总结

本文通过图解源码的方式，完整地介绍了整个 Netty 服务端的启动流程，并详细说明了在启动过程中涉及到的 `ServerBootstrap` 相关的属性和配置方式，以及 `NioServerSocketChannel` 的创建、初始化过程及其类的继承结构。

重点介绍了 `NioServerSocketChannel` 向 Reactor 的注册过程、Reactor 线程的启动时机以及 pipeline 的初始化时机。最后，我们介绍了 `NioServerSocketChannel` 绑定端口地址的整个流程。

上述流程全部是异步操作，各种回调交错，需要反复思考。阅读异步代码就是如此，需要理清各种回调之间的关系，并时刻提醒自己当前的执行线程是什么。

好了，现在 Netty 服务端已经启动，接下来就该接收客户端连接了。我们下篇文章见~~~~