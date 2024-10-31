# 处理 OP_ACCEPT 事件

## 前言

我们之前完整的介绍了 Netty 框架的骨架主从 Reactor 组的搭建过程，阐述了 Reactor 是如何被创建出来的，并介绍了它的核心组件如下图所示

![image-20241030172605776](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311612707.png)

- **thread**：Reactor 中的 IO 线程，主要负责监听 IO 事件、处理 IO 任务和执行异步任务。
- **selector**：JDK NIO 对操作系统底层 IO 多路复用技术的封装，用于监听 IO 就绪事件。
- **taskQueue**：用于保存 Reactor 需要执行的异步任务。这些异步任务可以由用户在业务线程中向 Reactor 提交，也可以是 Netty 框架提交的一些核心任务。
- **scheduledTaskQueue**：保存 Reactor 中执行的定时任务，代替原有的时间轮以执行延时任务。
- **tailQueue**：保存 Reactor 需要执行的一些尾部收尾任务。在普通任务执行完后，Reactor 线程会执行尾部任务，例如对 Netty 的运行状态进行一些统计数据，如任务循环的耗时和占用的物理内存大小等。



在骨架搭建完毕之后，我们随后介绍了 **本文的主角服务端 NioServerSocketChannel 的创建，初始化，绑定端口地址，向 main reactor 注册监听**`**OP_ACCEPT事件**`**的完整过程**。

![image-20241030172736143](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311546798.png)

接下来，我们需要等待客户端连接到我们的 Netty 服务器，这意味着 Main Reactor 正在等待 `OP_ACCEPT` 事件的到来。

本文的主要内容将集中在 Main Reactor 如何处理 `OP_ACCEPT` 事件。至此，Netty 框架的 Main Reactor Group 已经启动完毕，开始准备监听 `OP_ACCEPT` 事件。当客户端连接到服务器后，`OP_ACCEPT` 事件将变为活跃状态，Main Reactor 开始处理 `OP_ACCEPT` 事件以接收客户端连接。

在 Netty 中，IO 事件分为以下几类：

- **OP_ACCEPT 事件**
- **OP_READ 事件**
- **OP_WRITE 事件**
- **OP_CONNECT 事件**

Netty 对于 IO 事件的监听和处理统一封装在 Reactor 模型中。这四个 IO 事件的处理过程将在后续文章中单独介绍，本文将重点聚焦于 `OP_ACCEPT` 事件的处理。

![image-20241030172757750](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311608510.png)

Reactor 线程会在一个死循环中持续运转，轮询监听 Selector 上的 IO 事件。当 IO 事件变为活跃状态时，Reactor 将从 Selector 中被唤醒，转而执行 IO 就绪事件的处理。在这个过程中，我们引出了前述提到的四种 IO 事件的**处理入口函数**

```java
private void processSelectedKey(SelectionKey k, AbstractNioChannel ch) {
    //获取Channel的底层操作类Unsafe
    final AbstractNioChannel.NioUnsafe unsafe = ch.unsafe();
    if (!k.isValid()) {
        ......如果SelectionKey已经失效则关闭对应的Channel......
    }

    try {
        //获取IO就绪事件
        int readyOps = k.readyOps();
        //处理 Connect 事件
        if ((readyOps & SelectionKey.OP_CONNECT) != 0) {
            int ops = k.interestOps();
            //移除对Connect事件的监听，否则Selector会一直通知
            ops &= ~SelectionKey.OP_CONNECT;
            k.interestOps(ops);
            //触发channelActive事件处理Connect事件
            unsafe.finishConnect();
        }

        //处理Write事件
        if ((readyOps & SelectionKey.OP_WRITE) != 0) {
            ch.unsafe().forceFlush();
        }

         //处理Read事件或者Accept事件
        if ((readyOps & (SelectionKey.OP_READ | SelectionKey.OP_ACCEPT)) != 0 || readyOps == 0) {
            unsafe.read();
        }
    } catch (CancelledKeyException ignored) {
        unsafe.close(unsafe.voidPromise());
    }
}
```

本文将重点介绍 `OP_ACCEPT` 事件的处理入口函数 `unsafe.read()` 的整个源码实现。

当客户端连接完成三次握手后，Main Reactor 中的 Selector 产生 `OP_ACCEPT` 事件的活跃状态，Main Reactor 随即被唤醒，并进入 `OP_ACCEPT` 事件的处理入口函数，开始接收客户端连接。

## 1、Main Reactor 处理 OP_ACCEPT 事件

![image-20241031164503670](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311645839.png)

当 `Main Reactor` 轮询到 `NioServerSocketChannel` 上的 **OP_ACCEPT** 事件已就绪时，`Main Reactor` 线程会从 JDK `Selector` 的阻塞轮询 API 调用 `selector.select(timeoutMillis)` 中返回，并转而处理 `NioServerSocketChannel` 上的 **OP_ACCEPT** 事件。  

```java
public final class NioEventLoop extends SingleThreadEventLoop {

    private void processSelectedKey(SelectionKey k, AbstractNioChannel ch) {
        final AbstractNioChannel.NioUnsafe unsafe = ch.unsafe();
        ..............省略.................

        try {
            int readyOps = k.readyOps();

            if ((readyOps & SelectionKey.OP_CONNECT) != 0) {
               ..............处理OP_CONNECT事件.................
            }


            if ((readyOps & SelectionKey.OP_WRITE) != 0) {
              ..............处理OP_WRITE事件.................
            }


            if ((readyOps & (SelectionKey.OP_READ | SelectionKey.OP_ACCEPT)) != 0 || readyOps == 0) {
                //本文重点处理OP_ACCEPT事件
                unsafe.read();
            }
        } catch (CancelledKeyException ignored) {
            unsafe.close(unsafe.voidPromise());
        }
    }

}
```

- 在处理 IO 就绪事件的入口函数 `processSelectedKey` 中，参数 `AbstractNioChannel ch` 就是 Netty 服务端的 `NioServerSocketChannel`。由于当前执行线程为 **main reactor** 线程，而 `main reactor` 上注册的正是 Netty 服务端的 `NioServerSocketChannel`，负责监听端口地址并接收客户端连接。
- 通过 `ch.unsafe()` 获取的 `NioUnsafe` 操作类，实际上是 `NioServerSocketChannel` 中对底层 JDK NIO `ServerSocketChannel` 的 `Unsafe` 操作类。

**Unsafe** 接口是 Netty 对 `Channel` 底层操作行为的封装，比如 `NioServerSocketChannel` 的底层 `Unsafe` 操作类的主要职责是 **绑定端口地址** 和 **处理 OP_ACCEPT 事件**。  

 在 Netty 中，`OP_ACCEPT` 事件的处理入口函数被封装在 `NioServerSocketChannel` 的底层操作类 `Unsafe` 的 `read` 方法中。  

![image-20241031164525668](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311645723.png)

 在 `NioServerSocketChannel` 中，`Unsafe` 操作类的实现类型为 `NioMessageUnsafe`，它定义在继承结构中的父类 `AbstractNioMessageChannel` 中。接下来，我们深入到 `NioMessageUnsafe#read` 方法，来查看 Netty 对 **OP_ACCEPT** 事件的具体处理流程：  

## 2、接收客户端连接核心流程框架总览

关键代码如下

![image-20241030173237920](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301732963.png)

有朋友肯定会好奇，为啥 OP_READ 就绪事件和 OP_ACCEPT 就绪事件都是同一个 if 逻辑，其实这里用到了面向对象三大特性中的多态，会根据 Channel 的类型调用不同的逻辑，因为 sub Reactor和main Reactor所对应的Channel是不同类型的哈

![image-20241030173443086](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301734123.png)

所以在本文中，咱看 NioMessageUnsafe#read() 就可以了，

![image-20241030173706199](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301737297.png)



我们还是按照老规矩，先从整体上把的 NioMessageUnsafe#read() 逻辑处理框架提取出来，让大家先总体俯视下流程全貌，然后在针对每个核心点位进行各个击破。

![image-20241031164720178](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311647424.png)

Main Reactor 线程在一个 `do...while` 循环的 `read loop` 中不断调用 JDK NIO 的 `serverSocketChannel.accept()` 方法，以接收完成三次握手的客户端连接 `NioSocketChannel`。接收到的客户端连接 `NioSocketChannel` 会临时保存在 `List<Object> readBuf` 集合中，后续会通过服务端 `NioServerSocketChannel` 的 pipeline 中的 `ChannelRead` 事件进行传递，最终在 `ServerBootstrapAcceptor` 这个 `ChannelHandler` 中被初始化并注册到 Sub Reactor Group 中。

需要注意的是，`read loop` 循环的读取次数被限制为 16 次。当 Main Reactor 从 `NioServerSocketChannel` 中读取客户端连接 `NioSocketChannel` 的次数达到 16 次后，无论是否还有其他客户端连接，都会停止继续读取。

这是因为，在[天选打工人：核心引擎 Reactor 的运转架构](https://www.yuque.com/onejava/gwzrgm/zysbrxobzq8zxlxq)中提到，Netty 对 Reactor 线程的压力较大，需处理的任务繁多。除了监听和处理 IO 就绪事件外，还需要执行用户和 Netty 框架提交的异步任务和定时任务。因此，Main Reactor 线程不能无限制地执行 `read loop`，以确保有足够的时间来处理异步任务，避免因过多的连接接收而耽误异步任务的执行。

如果 Main Reactor 线程在 `read loop` 中读取客户端连接 `NioSocketChannel` 的次数已经达到 16 次，即使此时还有未接收的客户端连接，Main Reactor 线程也不会再接收，而是会转去执行异步任务。在异步任务执行完毕后，再回到 `read loop` 执行剩余的连接接收任务。



**Main Reactor 线程退出** `**read loop**` **循环的条件有两个：**

1. 在限定的 16 次读取中，已没有新的客户端连接可供接收，因而退出循环。
2. 从 `NioServerSocketChannel` 中读取客户端连接的次数已达 16 次，此时无论是否还有其他客户端连接，均需退出循环。

以上就是 Netty 在接收客户端连接时的整体核心逻辑。接下来，笔者将提取出这部分逻辑的核心源码实现框架，方便大家将上述核心逻辑与源码中的处理模块对应起来。请注意，大家只需总体把握核心处理流程，无需逐行理解每段代码。后续笔者将针对各个模块逐一进行深入解析。



```java
public abstract class AbstractNioMessageChannel extends AbstractNioChannel {

  private final class NioMessageUnsafe extends AbstractNioUnsafe {

        //存放连接建立后，创建的客户端SocketChannel
        private final List<Object> readBuf = new ArrayList<Object>();

        @Override
        public void read() {
            //必须在Main Reactor线程中执行
            assert eventLoop().inEventLoop();
            //注意下面的config和pipeline都是服务端ServerSocketChannel中的
            final ChannelConfig config = config();
            final ChannelPipeline pipeline = pipeline();
            //创建接收数据Buffer分配器（用于分配容量大小合适的byteBuffer用来容纳接收数据）
            //在接收连接的场景中，这里的allocHandle只是用于控制read loop的循环读取创建连接的次数。
            final RecvByteBufAllocator.Handle allocHandle = unsafe().recvBufAllocHandle();
            allocHandle.reset(config);

            boolean closed = false;
            Throwable exception = null;
            try {
                try {
                    do {
                        //底层调用NioServerSocketChannel->doReadMessages 创建客户端SocketChannel
                        int localRead = doReadMessages(readBuf);

                        //已无新的连接可接收则退出read loop
                        if (localRead == 0) {
                            break;
                        }
                        if (localRead < 0) {
                            closed = true;
                            break;
                        }
                        //统计在当前事件循环中已经读取到得Message数量（创建连接的个数）
                        allocHandle.incMessagesRead(localRead);
                    } while (allocHandle.continueReading());//判断是否已经读满16次
                } catch (Throwable t) {
                    exception = t;
                }

                int size = readBuf.size();
                for (int i = 0; i < size; i ++) {
                    readPending = false;
                    //在NioServerSocketChannel对应的pipeline中传播ChannelRead事件
                    //初始化客户端SocketChannel，并将其绑定到Sub Reactor线程组中的一个Reactor上
                    pipeline.fireChannelRead(readBuf.get(i));
                }
                //清除本次accept 创建的客户端SocketChannel集合
                readBuf.clear();
                allocHandle.readComplete();
                //触发readComplete事件传播
                pipeline.fireChannelReadComplete();
                ....................省略............
            } finally {
                ....................省略............
            }
        }
    }
  }
}
```

在 `NioMessageUnsafe#read` 方法中，首先通过断言 `assert eventLoop().inEventLoop()` 来确保当前线程为 **Main Reactor** 线程，以保证接收客户端连接的操作始终由 **Main Reactor** 线程完成。

由于 **Main Reactor** 主要负责注册和管理服务端的 `NioServerSocketChannel`，其核心职责是处理 **OP_ACCEPT** 事件，因此在当前 `main reactor` 线程中，正是在 `NioServerSocketChannel` 中执行接收客户端连接的任务。

此外，通过 `config()` 方法获取到的是 `NioServerSocketChannel` 的属性配置类 `NioServerSocketChannelConfig`。该配置类在 Reactor 启动阶段被创建，用于定义服务端 `NioServerSocketChannel` 的各项属性配置，如绑定的端口地址、接收缓冲区大小等，确保 Reactor 在启动时具备正确的配置。

```java
public NioServerSocketChannel(ServerSocketChannel channel) {
    //父类AbstractNioChannel中保存JDK NIO原生ServerSocketChannel以及要监听的事件OP_ACCEPT
    super(null, channel, SelectionKey.OP_ACCEPT);
    //DefaultChannelConfig中设置用于Channel接收数据用的buffer->AdaptiveRecvByteBufAllocator
    config = new NioServerSocketChannelConfig(this, javaChannel().socket());
}
```

同样地，通过 `pipeline()` 获取到的也是 `NioServerSocketChannel` 中的 **pipeline**。`pipeline` 会在 `NioServerSocketChannel` 成功注册到 **main reactor** 后被初始化，用于管理一系列 **ChannelHandler** 处理链，负责处理从事件捕获到响应生成的全过程。  

![image-20241030181159635](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301811694.png)



前面提到，Main Reactor 线程在 `read loop` 中会被限制只能读取 NioServerSocketChannel 中的客户端连接 16 次。因此，在开始 `read loop` 之前，我们需要创建一个能够保存读取次数的对象，以便在每次 `read loop` 循环后判断是否结束循环。

这个对象就是 `RecvByteBufAllocator.Handle allocHandle`，它专门用于统计 `read loop` 中接收客户端连接的次数，并判断是否该结束 `read loop` 转向执行异步任务。

当这一切准备就绪后，Main Reactor 线程便开始在 `do ... while` 循环中接收客户端连接。在 `read loop` 中，通过调用 `doReadMessages` 函数接收已完成三次握手的客户端连接。底层会调用 JDK NIO 的 `ServerSocketChannel` 的 `accept` 方法，从内核全连接队列中取出客户端连接。

返回值 `localRead` 表示接收到了多少客户端连接。由于 `accept` 方法一次只能接收一个连接，正常情况下 `localRead` 的返回值都会为 1。当 `localRead <= 0` 时，意味着已没有新的客户端连接可以接收，此时本次 Main Reactor 接收客户端的任务结束，跳出 `read loop`，进入新一轮的 IO 事件监听与处理。

```java
@Override
protected int doReadMessages(List<Object> buf) throws Exception {
    SocketChannel ch = SocketUtils.accept(javaChannel());

    try {
        if (ch != null) {
            buf.add(new NioSocketChannel(this, ch));
            return 1;
        }
    } catch (Throwable t) {
        logger.warn("Failed to create a new channel from an accepted socket.", t);

        try {
            ch.close();
        } catch (Throwable t2) {
            logger.warn("Failed to close a socket.", t2);
        }
    }

    return 0;
}
public static SocketChannel accept(final ServerSocketChannel serverSocketChannel) throws IOException {
    try {
        return AccessController.doPrivileged(new PrivilegedExceptionAction<SocketChannel>() {
            @Override
            public SocketChannel run() throws IOException {
                return serverSocketChannel.accept();
            }
        });
    } catch (PrivilegedActionException e) {
        throw (IOException) e.getCause();
    }
}
```

随后会将接收到的客户端连接占时存放到`List<Object> readBuf`集合中。

```java
private final class NioMessageUnsafe extends AbstractNioUnsafe {

    //存放连接建立后，创建的客户端SocketChannel
    private final List<Object> readBuf = new ArrayList<Object>();
}
```

在 `read loop` 中，通过调用 `allocHandle.incMessagesRead` 统计本次事件循环中接收到的客户端连接个数。最后，在 `read loop` 的末尾，通过 `allocHandle.continueReading` 判断是否达到了限定的 16 次。这将决定 Main Reactor 线程是继续接收客户端连接，还是转向执行异步任务。

当满足前述两个退出条件时，Main Reactor 线程将退出 `read loop`。在 `read loop` 中接收到的所有客户端连接会暂时存放在 `List<Object> readBuf` 集合中，随后会开始遍历 `readBuf`，并在 NioServerSocketChannel 的 pipeline 中传播 `ChannelRead` 事件。

```java
int size = readBuf.size();
for (int i = 0; i < size; i ++) {
    readPending = false;
    //NioServerSocketChannel对应的pipeline中传播read事件
    //io.netty.bootstrap.ServerBootstrap.ServerBootstrapAcceptor.channelRead
    //初始化客户端SocketChannel，并将其绑定到Sub Reactor线程组中的一个Reactor上
    pipeline.fireChannelRead(readBuf.get(i));
}
```



在Netty中，最终的**ChannelHandler**（`ServerBootstrapAcceptor`）会响应**ChannelRead**事件。它在相应的回调函数中执行以下操作：

1. 初始化客户端的`NioSocketChannel`。
2. 将初始化后的`NioSocketChannel`注册到**Sub Reactor Group**中。

一旦完成这些步骤，绑定到客户端`NioSocketChannel`的**Sub Reactor**将开始监听并处理客户端连接上的读写事件。

Netty整个接收客户端连接的逻辑过程如下图所示，步骤包括1、2、3：

![image-20241030181257484](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301812668.png)

以上内容就是笔者提取出来的整体流程框架，下面我们来将其中涉及到的重要核心模块拆开，一个一个详细解读下。

## 3、doReadMessages 接收客户端连接

```java
public class NioServerSocketChannel extends AbstractNioMessageChannel
                             implements io.netty.channel.socket.ServerSocketChannel {

    @Override
    protected int doReadMessages(List<Object> buf) throws Exception {
        SocketChannel ch = SocketUtils.accept(javaChannel());

        try {
            if (ch != null) {
                buf.add(new NioSocketChannel(this, ch));
                return 1;
            }
        } catch (Throwable t) {
            logger.warn("Failed to create a new channel from an accepted socket.", t);

            try {
                ch.close();
            } catch (Throwable t2) {
                logger.warn("Failed to close a socket.", t2);
            }
        }

        return 0;
    }

}
```

- 通过`javaChannel()`获取封装在Netty服务端`NioServerSocketChannel`中的`JDK 原生 ServerSocketChannel`。

```java
@Override
protected ServerSocketChannel javaChannel() {
    return (ServerSocketChannel) super.javaChannel();
}
```

- 通过`JDK NIO 原生`的`ServerSocketChannel`的`accept方法`获取`JDK NIO 原生`客户端连接`SocketChannel`。

```java
public static SocketChannel accept(final ServerSocketChannel serverSocketChannel) throws IOException {
    try {
        return AccessController.doPrivileged(new PrivilegedExceptionAction<SocketChannel>() {
            @Override
            public SocketChannel run() throws IOException {
                return serverSocketChannel.accept();
            }
        });
    } catch (PrivilegedActionException e) {
        throw (IOException) e.getCause();
    }
}
```

在这一步中，我们回顾之前在[从内核角度看 IO 模型](https://www.yuque.com/onejava/gwzrgm/dbuxe7ugyrdfzbhd)中介绍的内容：调用监听Socket的`accept`方法时，内核会基于监听Socket创建一个新的Socket，这个Socket专门用于与客户端之间的网络通信，我们称之为**客户端连接Socket**。在这个过程中：

- **ServerSocketChannel** 类似于监听 Socket
- **SocketChannel** 类似于客户端连接 Socket

由于我们在创建 `NioServerSocketChannel` 时将JDK NIO原生的 `ServerSocketChannel` 设置为非阻塞模式，因此，当 `ServerSocketChannel` 上有客户端连接时，会直接创建 `SocketChannel`。如果此时没有客户端连接，`accept` 调用会立即返回 `null`，而不会阻塞。

```java
protected AbstractNioChannel(Channel parent, SelectableChannel ch, int readInterestOp) {
    super(parent);
    this.ch = ch;
    this.readInterestOp = readInterestOp;
    try {
        //设置Channel为非阻塞 配合IO多路复用模型
        ch.configureBlocking(false);
    } catch (IOException e) {
      ..........省略.............
    }
}
```

### 3.1、创建客户端 NioSocketChannel

```java
public class NioServerSocketChannel extends AbstractNioMessageChannel
                             implements io.netty.channel.socket.ServerSocketChannel {

    @Override
    protected int doReadMessages(List<Object> buf) throws Exception {
        SocketChannel ch = SocketUtils.accept(javaChannel());

        try {
            if (ch != null) {
                buf.add(new NioSocketChannel(this, ch));
                return 1;
            }
        } catch (Throwable t) {
          .........省略.......
        }

        return 0;
    }

}
```

 在这一过程中，`ServerSocketChannel` 的 `accept` 方法将用于获取JDK NIO原生的 `SocketChannel`，该 `SocketChannel` 负责底层与客户端进行真实的通信。随后，Netty会基于该 `SocketChannel` 创建其自有的 `NioSocketChannel`。  

```java
public class NioSocketChannel extends AbstractNioByteChannel implements io.netty.channel.socket.SocketChannel {

    public NioSocketChannel(Channel parent, SocketChannel socket) {
        super(parent, socket);
        config = new NioSocketChannelConfig(this, socket.socket());
    }

}
```

创建客户端 `NioSocketChannel` 的过程与之前讨论的创建服务端 `NioServerSocketChannel` 的整体流程大致相同。在此，我们将重点对比这两者在创建过程中的不同之处。  

### 3.2、对比NioSocketChannel与NioServerSocketChannel的不同

#### 1：Channel 的层次不同

在我们之前介绍 **Reactor** 创建的文章中提到，Netty 中的 **Channel** 是具有层次结构的。

- 当 **客户端 NioSocketChannel** 在 **main reactor** 接收连接时，会通过服务端的 **NioServerSocketChannel** 创建。此时，在创建 **NioSocketChannel** 的构造函数中，`parent` 属性会被指定为 **NioServerSocketChannel**，并将 JDK NIO 原生的 **SocketChannel** 封装到 Netty 的 **NioSocketChannel** 中。
- 相对而言，在 **Reactor** 启动过程中创建 **NioServerSocketChannel** 时，`parent` 属性被指定为 `null`。这是因为 **NioServerSocketChannel** 是顶层的 Channel，主要负责创建 **NioSocketChannel**。

```java
public NioServerSocketChannel(ServerSocketChannel channel) {
    super(null, channel, SelectionKey.OP_ACCEPT);
    config = new NioServerSocketChannelConfig(this, javaChannel().socket());
}
```

#### 2：向 Reactor 注册的IO事件不同

客户端 NioSocketChannel 向 Sub Reactor 注册的是`SelectionKey.OP_READ事件`，而服务端NioServerSocketChannel 向 Main Reactor 注册的是`SelectionKey.OP_ACCEPT事件`。

这里的说法不算严谨，比如 NioSocketChannel 在客户端建立连接的时候可能会注册 OP_CONNECT 事件，在[Netty 如何建立网络连接](https://www.yuque.com/onejava/gwzrgm/udg76b6z7ir6ld45)中有提及，然后在 TCP 缓冲区由不可写变为可写时也需要注册 OP_WRITE 事件去进行监听

```java
public abstract class AbstractNioByteChannel extends AbstractNioChannel {

    protected AbstractNioByteChannel(Channel parent, SelectableChannel ch) {
        super(parent, ch, SelectionKey.OP_READ);
    }

}

public class NioServerSocketChannel extends AbstractNioMessageChannel
                             implements io.netty.channel.socket.ServerSocketChannel {

   public NioServerSocketChannel(ServerSocketChannel channel) {
        //父类AbstractNioChannel中保存JDK NIO原生ServerSocketChannel以及要监听的事件OP_ACCEPT
        super(null, channel, SelectionKey.OP_ACCEPT);
        //DefaultChannelConfig中设置用于Channel接收数据用的buffer->AdaptiveRecvByteBufAllocator
        config = new NioServerSocketChannelConfig(this, javaChannel().socket());
    }
}
```

#### 3：功能属性不同造成继承结构的不同

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729677799446-7c344bc7-7314-48ad-ba2c-712ea9a840e5.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729677806390-d2016b42-d141-429a-a6d9-6770e9d039a2.png)



在Netty中，客户端的 `NioSocketChannel` 和 服务端的 `NioServerSocketChannel` 分别继承了不同的抽象类：

- `NioSocketChannel` 继承自 `AbstractNioByteChannel`
- `NioServerSocketChannel` 继承自 `AbstractNioMessageChannel`

这两个抽象类的命名前缀（`Byte` 与 `Message`）代表了它们的不同功能和用途：

1. `AbstractNioByteChannel`

- - `NioSocketChannel` 主要处理客户端与服务端之间的通信。它的主要职责是接收客户端发送的数据。
  - 数据单位：网络通信的数据单位是 Byte，因此 `NioSocketChannel` 读取的数据以字节为单位。

1. `AbstractNioMessageChannel`

- - `NioServerSocketChannel` 主要负责处理 `OP_ACCEPT` 事件，并创建用于通信的 `NioSocketChannel` 实例。
  - 数据单位：在客户端与服务端尚未开始通信的情况下，`NioServerSocketChannel` 从读取对象中获取的是 Message。这里的 Message 指的是底层的 SocketChannel 客户端连接。

------

以上就是`NioSocketChannel`与`NioServerSocketChannel`创建过程中的不同之处，后面的过程就一样了。

- 在AbstractNioChannel 类中封装JDK NIO 原生的`SocketChannel`，并将其底层的IO模型设置为`非阻塞`，保存需要监听的IO事件`OP_READ`。

```java
protected AbstractNioChannel(Channel parent, SelectableChannel ch, int readInterestOp) {
    super(parent);
    this.ch = ch;
    this.readInterestOp = readInterestOp;
    try {
        //设置Channel为非阻塞 配合IO多路复用模型
        ch.configureBlocking(false);
    } catch (IOException e) {

    }
}
```

- 为客户端NioSocketChannel创建全局唯一的`channelId`，创建客户端NioSocketChannel的底层操作类`NioByteUnsafe`，创建pipeline。

```java
protected AbstractChannel(Channel parent) {
    this.parent = parent;
    //channel全局唯一ID machineId+processId+sequence+timestamp+random
    id = newId();
    //unsafe用于底层socket的读写操作
    unsafe = newUnsafe();
    //为channel分配独立的pipeline用于IO事件编排
    pipeline = newChannelPipeline();
}
```

- 在NioSocketChannelConfig的创建过程中，将NioSocketChannel的RecvByteBufAllocator类型设置为`AdaptiveRecvByteBufAllocator`。

```java
public DefaultChannelConfig(Channel channel) {
    this(channel, new AdaptiveRecvByteBufAllocator());
}
```

最终我们得到的客户端`NioSocketChannel`结构如下：

![image-20241030184812566](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301848847.png)

## 4、ChannelRead 事件的响应

![image-20241030181027564](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301810810.png)

在前面介绍接收连接的整体核心流程框架时，我们提到，**main reactor线程**是在一个 `do {...} while(...)` 循环的 **read loop** 中，不断调用 `ServerSocketChannel#accept` 方法来接收客户端的连接。

当满足退出 **read loop** 循环的条件时，有两个主要情形：

1. 在限定的 16 次读取中，已没有新的客户端连接要接收，此时退出循环。
2. 从 `NioServerSocketChannel` 中读取客户端连接的次数达到了 16 次，无论此时是否还有客户端连接，都需要退出循环。

在满足上述条件后，**main reactor** 将退出 **read loop** 循环，此时接收到的客户端连接 `NioSocketChannel` 暂时存放在 `List<Object> readBuf` 集合中。

```java
private final class NioMessageUnsafe extends AbstractNioUnsafe {

    private final List<Object> readBuf = new ArrayList<Object>();

    @Override
    public void read() {
        try {
            try {
                do {
                    ........省略.........
                    //底层调用NioServerSocketChannel->doReadMessages 创建客户端SocketChannel
                    int localRead = doReadMessages(readBuf);
                    ........省略.........
                    allocHandle.incMessagesRead(localRead);
                } while (allocHandle.continueReading());

            } catch (Throwable t) {
                exception = t;
            }

            int size = readBuf.size();
            for (int i = 0; i < size; i ++) {
                readPending = false;
                pipeline.fireChannelRead(readBuf.get(i));
            }
            
              ........省略.........
        } finally {
              ........省略.........
        }
    }
}
```

 随后，**main reactor线程** 将遍历 `List<Object> readBuf` 集合中的 `NioSocketChannel`，并在 `NioServerSocketChannel` 的 **pipeline** 中传播 **ChannelRead** 事件。  

![image-20241030185234229](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301852404.png)

最终，**ChannelRead** 事件将传播到 **ServerBootstrapAcceptor** 中，这里是 Netty 处理客户端连接的核心逻辑所在。

**ServerBootstrapAcceptor** 的主要作用是初始化客户端的 `NioSocketChannel`，并将其注册到 **Sub Reactor Group** 中，同时监听 **OP_READ** 事件。在 **ServerBootstrapAcceptor** 中，将初始化客户端 `NioSocketChannel` 的以下属性：

- **从** **Reactor 组** 的 `EventLoopGroup childGroup` 初始化 `NioSocketChannel` 中的 **pipeline** 所需的 **ChannelHandler childHandler**。
- 配置 `NioSocketChannel` 中的一些 **childOptions** 和 **childAttrs**。

```java
private static class ServerBootstrapAcceptor extends ChannelInboundHandlerAdapter {

    private final EventLoopGroup childGroup;
    private final ChannelHandler childHandler;
    private final Entry<ChannelOption<?>, Object>[] childOptions;
    private final Entry<AttributeKey<?>, Object>[] childAttrs;

    @Override
    @SuppressWarnings("unchecked")
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        final Channel child = (Channel) msg;

        //向客户端NioSocketChannel的pipeline中
        //添加在启动配置类ServerBootstrap中配置的ChannelHandler
        child.pipeline().addLast(childHandler);

        //利用配置的属性初始化客户端NioSocketChannel
        setChannelOptions(child, childOptions, logger);
        setAttributes(child, childAttrs);

        try {
            /**
             * 1：在Sub Reactor线程组中选择一个Reactor绑定
             * 2：将客户端SocketChannel注册到绑定的Reactor上
             * 3：SocketChannel注册到sub reactor中的selector上，并监听OP_READ事件
             * */
            childGroup.register(child).addListener(new ChannelFutureListener() {
                @Override
                public void operationComplete(ChannelFuture future) throws Exception {
                    if (!future.isSuccess()) {
                        forceClose(child, future.cause());
                    }
                }
            });
        } catch (Throwable t) {
            forceClose(child, t);
        }
    }
}
```

正是在这里，netty会将我们在[BootStrap 解密：主 Reactor Group 启动全流程](https://www.yuque.com/onejava/gwzrgm/tviszqce4k0kqxfy)的启动示例程序中在ServerBootstrap中配置的客户端NioSocketChannel的所有属性（child前缀配置）初始化到NioSocketChannel中。

```java
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

 在上述示例代码中，通过 `ServerBootstrap` 配置的 `NioSocketChannel` 相关属性，会在 Netty 启动并初始化 `NioServerSocketChannel` 时，将 `ServerBootstrapAcceptor` 的创建和初始化工作封装成异步任务。随后，在 `NioServerSocketChannel` 成功注册到主 Reactor 中后，这些任务将被执行。  

```java
public class ServerBootstrap extends AbstractBootstrap<ServerBootstrap, ServerChannel> {

    @Override
    void init(Channel channel) {
        ................省略................

        p.addLast(new ChannelInitializer<Channel>() {
            @Override
            public void initChannel(final Channel ch) {
                final ChannelPipeline pipeline = ch.pipeline();
                ................省略................
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
}
```

在经过`ServerBootstrapAccptor#chanelRead回调`的处理之后，此时客户端NioSocketChannel中pipeline的结构为：

![image-20241031164824410](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311648472.png)

随后会将初始化好的客户端NioSocketChannel向Sub Reactor Group中注册，并监听`OP_READ事件`。

## 5、向SubReactorGroup中注册NioSocketChannel

```java
childGroup.register(child).addListener(new ChannelFutureListener() {
    @Override
    public void operationComplete(ChannelFuture future) throws Exception {
        if (!future.isSuccess()) {
            forceClose(child, future.cause());
        }
    }
});
```

客户端NioSocketChannel向Sub Reactor Group注册的流程完全和服务端NioServerSocketChannel向Main Reactor Group注册流程一样。

关于服务端NioServerSocketChannel的注册流程，笔者已经在[BootStrap：Reactor Group 启动全流程](https://www.yuque.com/onejava/gwzrgm/tviszqce4k0kqxfy)一文中做出了详细的介绍，对相关细节感兴趣的同学可以在回看下。

这里笔者在带大家简要回顾下整个注册过程并着重区别对比客户端NioSocetChannel与服务端NioServerSocketChannel注册过程中不同的地方

### 5.1、从 Sub Reactor Group 中选取一个 Sub Reactor 进行绑定

```java
public abstract class MultithreadEventLoopGroup extends MultithreadEventExecutorGroup implements EventLoopGroup {

   @Override
    public ChannelFuture register(Channel channel) {
        return next().register(channel);
    }

    @Override
    public EventExecutor next() {
        return chooser.next();
    }

}
```

### 5.2、向绑定的 Sub Reactor 上注册 NioSocketChannel

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
```

- 在介绍 `NioServerSocketChannel` 的注册过程时，这里的 `promise.channel()` 为 `NioServerSocketChannel`，而底层的 `unsafe` 操作类为 `NioMessageUnsafe`。
- 此时，这里的 `promise.channel()` 为 `NioSocketChannel`，底层的 `unsafe` 操作类为 `NioByteUnsafe`。

```java
@Override
public final void register(EventLoop eventLoop, final ChannelPromise promise) {
    ..............省略....................
    //此时这里的eventLoop为Sub Reactor
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
            ..............省略....................
        }
    }
}
```

注意，此时传递进来的 `EventLoop` 为 Sub Reactor。但执行线程为 Main Reactor 线程，而不是 Sub Reactor 线程（此时 Sub Reactor 还未启动）。因此，这里的 `eventLoop.inEventLoop()` 返回的是 `false`。  

在 `else` 分支中，向绑定的 Sub Reactor 提交注册 `NioSocketChannel` 的任务。注册任务提交后，此时绑定的 Sub Reactor 线程会启动。

### 5.3、register0

我们再次来到了 Channel 注册的老地方，即 `register0` 方法。在[BootStrap：Reactor Group 启动全流程](https://www.yuque.com/onejava/gwzrgm/tviszqce4k0kqxfy)中，我们花了大量篇幅介绍了这个方法。此处我们只对比 `NioSocketChannel` 与 `NioServerSocketChannel` 的不同之处。  

```java
private void register0(ChannelPromise promise) {
    try {
        ................省略..................
        boolean firstRegistration = neverRegistered;
        //执行真正的注册操作
        doRegister();
        //修改注册状态
        neverRegistered = false;
        registered = true;

        pipeline.invokeHandlerAddedIfNeeded();
    
        safeSetSuccess(promise);
        pipeline.fireChannelRegistered();
        if (isActive()) {
            if (firstRegistration) {
                //触发channelActive事件
                pipeline.fireChannelActive();
            } else if (config().isAutoRead()) {
                beginRead();
            }
        }
    } catch (Throwable t) {
         ................省略..................
    }
}
```

这里 `doRegister()方法`将NioSocketChannel注册到Sub Reactor中的`Selector`上。

```java
public abstract class AbstractNioChannel extends AbstractChannel {

    @Override
    protected void doRegister() throws Exception {
        boolean selected = false;
        for (;;) {
            try {
                selectionKey = javaChannel().register(eventLoop().unwrappedSelector(), 0, this);
                return;
            } catch (CancelledKeyException e) {
                ...............省略...............
            }
        }
    }

}
```

这里是 Netty 客户端 `NioSocketChannel` 与 JDK NIO 原生 `SocketChannel` 关联的地方。此时，注册的 IO 事件仍然为 0，目的是为了获取 `NioSocketChannel` 在 `Selector` 中的 `SelectionKey`。

同时，通过 `SelectableChannel#register` 方法，将 Netty 自定义的 `NioSocketChannel`（此处的 `this` 指针）附加在 `SelectionKey` 的 `attachment` 属性上，完成 Netty 自定义 Channel 与 JDK NIO Channel 的关系绑定。这样，在每次对 `Selector` 进行 IO 就绪事件轮询时，Netty 都可以从 JDK NIO `Selector` 返回的 `SelectionKey` 中获取到自定义的 Channel 对象（此处指的就是 `NioSocketChannel`）。

![image-20241030185551602](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301855649.png)

![image-20241031164956914](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311649020.png)

 随后调用 `pipeline.invokeHandlerAddedIfNeeded()` 回调客户端 `NioSocketChannel` 上 `pipeline` 中所有 `ChannelHandler` 的 `handlerAdded` 方法。此时，`pipeline` 的结构中只有一个 `ChannelInitializer`。最终会在 `ChannelInitializer#handlerAdded` 回调方法中初始化客户端 `NioSocketChannel` 的 `pipeline`。  

![image-20241031164824410](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311648472.png)

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

    protected abstract void initChannel(C ch) throws Exception;
}
```

关于对Channel中pipeline的详细初始化过程，对细节部分感兴趣的同学可以回看下[BootStrap：Reactor Group 启动全流程](https://www.yuque.com/onejava/gwzrgm/tviszqce4k0kqxfy)

 此时，客户端 `NioSocketChannel` 中 `pipeline` 的结构变为了我们自定义的样子。在示例代码中，我们自定义的 `ChannelHandler` 为 `EchoServerHandler`。  

![image-20241031165026880](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311650961.png)

```java
@Sharable
public class EchoServerHandler extends ChannelInboundHandlerAdapter {

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        ctx.write(msg);
    }

    @Override
    public void channelReadComplete(ChannelHandlerContext ctx) {

        ctx.flush();
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        // Close the connection when an exception is raised.
        cause.printStackTrace();
        ctx.close();
    }
}
```

 当客户端 `NioSocketChannel` 中的 `pipeline` 初始化完毕后，Netty 开始调用 `safeSetSuccess(promise)` 方法，回调 `regFuture` 中注册的 `ChannelFutureListener`，通知客户端 `NioSocketChannel` 已经成功注册到 Sub Reactor 上。  

```java
childGroup.register(child).addListener(new ChannelFutureListener() {
    @Override
    public void operationComplete(ChannelFuture future) throws Exception {
        if (!future.isSuccess()) {
            forceClose(child, future.cause());
        }
    }
});
```

 在服务端 `NioServerSocketChannel` 注册时，我们会在 `listener` 中向 Main Reactor 提交绑定端口地址的任务。然而，在 `NioSocketChannel` 注册时，只会在 `listener` 中处理注册失败的情况。  

 当 Sub Reactor 线程通知 `ChannelFutureListener` 注册成功之后，随后会调用 `pipeline.fireChannelRegistered()` 在客户端 `NioSocketChannel` 的 `pipeline` 中传播 `ChannelRegistered` 事件。  

**这里笔者重点强调**，在之前介绍 `NioServerSocketChannel` 注册时，我们提到由于此时 `NioServerSocketChannel` 并未绑定端口地址，因此它并未激活，此时的 `isActive()` 返回 `false`，`register0` 方法直接返回。  

 服务端 `NioServerSocketChannel` 判断是否激活的标准为端口是否绑定成功。  

```java
public class NioServerSocketChannel extends AbstractNioMessageChannel
                             implements io.netty.channel.socket.ServerSocketChannel {
    @Override
    public boolean isActive() {
        return isOpen() && javaChannel().socket().isBound();
    }
}
```

客户端 `NioSocketChannel` 判断是否激活的标准为是否处于 Connected 状态。显然，此时它肯定是处于 Connected 状态的。  

```java
@Override
public boolean isActive() {
    SocketChannel ch = javaChannel();
    return ch.isOpen() && ch.isConnected();
}
```

`NioSocketChannel` 已经处于 Connected 状态，这里并不需要绑定端口，因此此时的 `isActive()` 返回 `true`。  

```java
if (isActive()) {
        /**
         * 客户端SocketChannel注册成功后会走这里，在channelActive事件回调中注册OP_READ事件
         * */
        if (firstRegistration) {
            //触发channelActive事件
            pipeline.fireChannelActive();
        } else if (config().isAutoRead()) {
            .......省略..........
        }
    }
}
```

最后调用 `pipeline.fireChannelActive()` 在 `NioSocketChannel` 的 `pipeline` 中传播 `ChannelActive` 事件，最终在 `pipeline` 的头结点 `HeadContext` 中响应`ChannelActive`事件并注册 `OP_READ` 事件到 Sub Reactor 中的 `Selector` 上。  

![](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311650961.png)

```java
public abstract class AbstractNioChannel extends AbstractChannel { {

    @Override
    protected void doBeginRead() throws Exception {
        ..............省略................

        final int interestOps = selectionKey.interestOps();
        /**
         * 1：ServerSocketChannel 初始化时 readInterestOp设置的是OP_ACCEPT事件
         * 2：SocketChannel 初始化时 readInterestOp设置的是OP_READ事件
         * */
        if ((interestOps & readInterestOp) == 0) {
            //注册监听OP_ACCEPT或者OP_READ事件
            selectionKey.interestOps(interestOps | readInterestOp);
        }
    }

}
```

 注意，这里的 `readInterestOp` 为客户端 `NioSocketChannel` 在初始化时设置的 `OP_READ` 事件。  

------

 到这里，Netty 中 Main Reactor 接收连接的整个流程就介绍完毕。此时，Netty 中主从 Reactor 组的结构变为：  

![image-20241031165217159](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311652414.png)

## 总结

本文介绍了 `NioServerSocketChannel` 处理客户端连接事件的整个过程。

- 接收连接的整个处理框架。
- 影响 Netty 接收连接吞吐的 Bug 产生的原因，以及修复方案。
- 创建并初始化客户端 `NioSocketChannel`。
- 初始化 `NioSocketChannel` 中的 `pipeline`。
- 客户端 `NioSocketChannel` 向 Sub Reactor 注册的过程。

其中，我们也对比了 `NioServerSocketChannel` 与 `NioSocketChannel` 在创建初始化以及后续向 Reactor 注册过程中的差异。

当客户端 `NioSocketChannel` 接收完毕并向 Sub Reactor 注册成功后，Sub Reactor 就开始监听注册在其上的所有客户端 `NioSocketChannel` 的 `OP_READ` 事件，并等待客户端向服务端发送网络数据。

接下来，Reactor 的主角将转变为 Sub Reactor 及其注册的客户端 `NioSocketChannel`。

下篇文章，我们将讨论 Netty 是如何接收网络数据的。我们下篇文章见~~