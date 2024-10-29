# Java NIO 详解

## 前言

有了 [从内核角度看 IO 模型](https://www.yuque.com/onejava/gwzrgm/dbuxe7ugyrdfzbhd) 和 [IO 多路复用的操作系统支持](https://www.yuque.com/onejava/gwzrgm/mrhc4wo4wqbd4csq) 这两篇文章的基础，你应该对 IO 模型和 IO 线程模型的底层有了较为清楚的认识。接下来，我们就来看看 JDK 是如何实现 NIO 模型的。

虽然 Netty 也实现了类似的 NIO 模型，但 Netty 的底层也是依靠 JDK 中的 NIO 组件去构建的。因此，学习 Java NIO 是我们的一项必要任务！

## NIO 的起源

NIO技术是怎么来的？为啥需要这个技术呢？先给出一份在 Java NIO 出来之前，服务器端同步阻塞 I/O 处理（也就是BIO，Blocking I/O）的参考代码：

```java
class ConnectionPerThreadWithPool implements Runnable
{
    public void run()
    {
        //线程池
        //注意，生产环境不能这么用，具体请参考《java高并发核心编程卷2》
        ExecutorService executor = Executors.newFixedThreadPool(100);
        try
        {
            //服务器监听socket
            ServerSocket serverSocket =
                    new ServerSocket(NioDemoConfig.SOCKET_SERVER_PORT);
           //主线程死循环, 等待新连接到来
            while (!Thread.interrupted())
            {
                Socket socket = serverSocket.accept();
                //接收一个连接后，为socket连接，新建一个专属的处理器对象
                Handler handler = new Handler(socket);
                //创建新线程来handle
                //或者，使用线程池来处理
                new Thread(handler).start();
            }

        } catch (IOException ex)
        { /* 处理异常 */ }
    }

    static class Handler implements Runnable
    {
        final Socket socket;
        Handler(Socket s)
        {
            socket = s;
        }
        public void run()
        {
            //死循环处理读写事件
            boolean ioCompleted=false;
            while (!ioCompleted)
            {
                try
                {
                    byte[] input = new byte[NioDemoConfig.SERVER_BUFFER_SIZE];
                    /* 读取数据 */
                    socket.getInputStream().read(input);
                    // 如果读取到结束标志
                    // ioCompleted= true
                    // socket.close();

                    /* 处理业务逻辑，获取处理结果 */
                    byte[] output = null;
                    /* 写入结果 */
                    socket.getOutputStream().write(output);
                } catch (IOException ex)
                { /*处理异常*/ }
            }
        }
    }
}
```

### Connection Per Thread 模式

在上述示例代码中，对于每一个新的网络连接，都会通过线程池分配一个专门的线程去负责 I/O 处理。每个线程独立处理自己负责的 Socket 连接的输入和输出。同时，服务器的监听线程也是独立的，这样任何 Socket 连接的输入和输出处理都不会阻塞后续新 Socket 连接的监听和建立，从而提升了服务器的吞吐量。这一实现方式早在 Tomcat 的早期版本中就得到了应用。

这种设计模式被称为 **每连接每线程模型**（Connection Per Thread 模式）。在活动连接数不超过 1000 的情况下，这种模式表现良好，能够使每个连接专注于其 I/O 处理，且编程模型简单，无需过多考虑系统的过载和限流问题。此模型通常与线程池结合使用，线程池本身就充当了一个天然的漏斗，可以缓冲一些系统处理不了的连接或请求。

#### 模型的局限性

然而，这种模型的核心问题在于它严重依赖于线程。线程是一种昂贵的资源，主要表现在以下几个方面：

1. **线程创建和销毁成本高**
   线程的创建和销毁需要通过重量级的系统调用来完成。
2. **内存占用大**
   Java 线程的栈内存一般至少分配 512K 至 1M 的空间。如果系统中的线程数超过千个，整个 JVM 的内存将消耗超过 1G。
3. **线程切换成本高**
   操作系统在进行线程切换时，需要保存线程的上下文，并执行系统调用。过多的线程频繁切换可能导致切换所需的时间超过线程执行的时间，通常表现为系统 CPU 的 `sy` 值异常高（超过 20%），从而使系统几乎不可用。
4. **无效的等待时间**

1. 1. 大量线程的大部分时间都是在阻塞等待IO，所以根本没必要创建这么多线程，完全是浪费线程



#### CPU 利用率说明

CPU 利用率由 CPU 在用户进程、内核、中断处理、I/O 等待和空闲时间五个部分的使用百分比组成。人们常通过这五个部分的各种组合，来分析 CPU 消耗情况的关键指标。特别地，CPU `sy` 值表示内核线程处理所占的百分比。

可以通过 Linux 的 `top` 命令查看当前系统的资源，输出示例如下：

```plain
top - 23:22:02 up 5:47, 1 user, load average: 0.00, 0.00, 0.00

Tasks: 107 total, 1 running, 106 sleeping, 0 stopped, 0 zombie

%Cpu(s): 0.3%us, 0.3%sy, 0.0%ni, 99.3%id, 0.0%wa, 0.0%hi, 0.0%si, 0.0%st

Mem: 1017464k total, 359292k used, 658172k free, 56748k buffers

Swap: 2064376k total, 0k used, 2064376k free, 106200k cached
```

在输出信息的第三行中：

- `0.3%sy` 表示内核线程处理所占的百分比。
- `99.3%id` 表示 CPU 空闲时间所占的百分比。

因此，当 CPU `sy` 值高时，表示系统调用耗费了较多的 CPU。对于 Java 应用程序而言，造成这种现象的主要原因是启动的线程较多，并且这些线程多数处于不断的等待（如锁等待状态）和执行状态的变化中，这就导致操作系统要不断调度这些线程，进行切换执行。

#### 锯齿状的系统负载

此外，线程数量的增加还容易造成锯齿状的系统负载。系统负载（System Load）指当前正在被 CPU 执行和等待被 CPU 执行的进程数总和，是反映系统忙闲程度的重要指标。当负载值低于 CPU 数目时，表示 CPU 有空闲，资源存在浪费；当负载值高于 CPU 数目时，表示进程在排队等待 CPU，表明系统资源不足，影响应用程序的执行性能。

### Multi Connection Per Thread 模型

```java
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

public class PollingNonBlockingTCPServer {

private static final int PORT = 8080;
private static final int TIMEOUT = 100; // 轮询间隔（毫秒）

public static void main(String[] args) {
    try (ServerSocket serverSocket = new ServerSocket(PORT)) {
        serverSocket.setSoTimeout(TIMEOUT); // 设置非阻塞模式的超时
        System.out.println("服务器已启动，监听端口: " + PORT);

        List<Socket> clientSockets = new ArrayList<>(); // 存储客户端连接

        while (true) {
            try {
                // 接受新连接
                Socket clientSocket = serverSocket.accept();
                clientSocket.setSoTimeout(TIMEOUT); // 设置客户端非阻塞超时
                clientSockets.add(clientSocket);
                System.out.println("新客户端连接: " + clientSocket.getRemoteSocketAddress());
            } catch (SocketTimeoutException e) {
                // 没有新连接，继续轮询
            }

            // 轮询每个客户端的连接状态
            Iterator<Socket> iterator = clientSockets.iterator();
            while (iterator.hasNext()) {
                Socket socket = iterator.next();
                try {
                    // 检查是否有数据可读取
                    InputStream inputStream = socket.getInputStream();
                    if (inputStream.available() > 0) {
                        byte[] buffer = new byte[1024];
                        int bytesRead = inputStream.read(buffer);
                        String message = new String(buffer, 0, bytesRead);
                        System.out.println("收到消息: " + message);

                        // 响应客户端
                        OutputStream outputStream = socket.getOutputStream();
                        outputStream.write("消息已收到\n".getBytes());
                        outputStream.flush();
                    }
                } catch (IOException e) {
                    System.out.println("客户端断开连接: " + socket.getRemoteSocketAddress());
                    try {
                        socket.close();
                    } catch (IOException ex) {
                        ex.printStackTrace();
                    }
                    iterator.remove(); // 从列表中移除断开连接的客户端
                }
            }

            // 模拟短暂的休眠，避免 CPU 占用过高
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                e.printStackTrace();
            }
        }
    } catch (IOException e) {
        e.printStackTrace();
    }
}
```

这种轮询方法使用单线程依次检查每个连接的状态，对于少量连接的非阻塞 I/O 是可行的，但当客户端数量增加时，单线程轮询的效率会显著下降。 



**总之，当面对十万甚至百万级连接时，传统的 BIO 模型已显得无能为力。**

**随着移动端应用的兴起和各种网络游戏的盛行，高并发的需求越来越普遍。此时，必然需要一种更高效的 I/O 处理组件——这就是 Java 的 NIO 编程组件。** 



## NIO 概述

Java NIO 有三个核心组成：

- Channel
- Buffer
- Selector

Java NIO 中，虽然有许多类和组件，但 `Channel`、`Buffer` 和 `Selector` 是其核心。其他组件（例如 `Pipe` 和 `FileLock`）主要作为工具类，配合这三大核心组件使用。因此，在本次 NIO 概述中将主要聚焦于这三个核心组件。其他组件的说明在教程的其他部分进行了详细解释，您可以在页面右上角的菜单中找到相关内容。  

### NIO 和 OIO（即BIO） 的对比

1. **OIO 是面向流（Stream Oriented）的，NIO 是面向缓冲区（Buffer Oriented）的**

在面向流的OIO操作中，IO的 read() 操作总是以流式的方式顺序地从一个流（Stream）中读取一个或多个字节，因此，我们不能随意地改变读取指针的位置，也不能前后移动流中的数据。

而NIO中引入了Channel（通道）和Buffer（缓冲区）的概念。面向缓冲区的读取和写入，都是与Buffer进行交互。用户程序只需要从通道中读取数据到缓冲区中，或将数据从缓冲区中写入到通道中。NIO不像OIO那样是顺序操作，可以随意地读取Buffer中任意位置的数据，可以随意修改Buffer中任意位置的数据。

1. **OIO的操作是阻塞的，而NIO的操作是非阻塞的**

OIO的操作是阻塞的，当一个线程调用read() 或 write()时，该线程被阻塞，直到有一些数据被读取，或数据完全写入。该线程在此期间不能再干任何事情了。例如，我们调用一个read方法读取一个文件的内容，那么调用read的线程会被阻塞住，直到read操作完成。

NIO如何做到非阻塞的呢？当我们调用read方法时，系统底层已经把数据准备好了，应用程序只需要从通道把数据复制到Buffer（缓冲区）就行；如果没有数据，当前线程可以去干别的事情，不需要进行阻塞等待。

NIO的非阻塞是如何做到的呢？其实在上一章，答案已经揭晓了，根本原因是：NIO使用了通道和通道的IO多路复用技术。

1. **IO没有选择器（Selector）概念，而 NIO 有选择器的概念**

NIO技术的实现，是基于底层的IO多路复用技术实现的，比如在Windows中需要select多路复用组件的支持，在Linux系统中需要select/poll/epoll多路复用组件的支持。所以NIO的需要底层操作系统提供支持。而OIO不需要用到选择器。

### stream 和 channel 的区别

通道（`Channel`）：由 `java.nio.channels` 包定义，表示 IO 源与目标之间打开的连接。`Channel` 类似于传统的“流”，但 **Channel 本身不能直接访问数据**，只能与 **Buffer** 进行交互。由于 `Channel` 本身不存储数据，因此需要与缓冲区配合进行传输。

NIO 是从 JDK 1.4 开始提供的一种新的 IO 方式。原有的 I/O 库（在 `java.io.*` 中）与 NIO 之间最重要的区别在于数据打包和传输的方式。原有的 I/O 以流的方式处理数据，而 NIO 以块（`buffer`）的方式处理数据。

面向流的 I/O 系统一次处理一个字节的数据：一个输入流产生一个字节的数据，一个输出流消费一个字节的数据。相较之下，面向流的 I/O 通常相当慢。

面向块的 I/O 系统则以块的形式处理数据：每一个操作都在一步中产生或消费一个数据块。按块处理数据比按字节处理数据要快得多。这是因为应用程序从磁盘读取数据时，并不是直接从磁盘取数据，而是先由操作系统将磁盘上的数据读到系统内存中。这一步是操作系统的 I/O，不由应用程序控制；然后，应用程序再将数据从系统内存读取到应用内存中，这一步才是程序中的 I/O 操作。

操作系统通常一次将一块数据从磁盘移动到系统内存。基于块的 I/O 和基于流的 I/O 的不同之处在于，基于流的 I/O 需要一个个字符地将系统内存上的数据移动到应用内存，而基于块的 I/O 则一次性将数据移动到应用内存，因此效率更高。

然而，在 JDK 1.4 之后，BIO 的底层也部分重写为 NIO 方式，因此在文件读写效率方面，两者的差别已经不大。最重要的差别是 NIO 提供了 **异步非阻塞** 的网络编程模型，这是 BIO 所无法实现的。



![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730098830420-8e3959e0-7ff7-4a3a-b051-9b76db442c8d.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

### Channels and Buffers

在 Java NIO 中，通常所有的 IO 操作都始于 `Channel`。`Channel` 有点类似于流（stream）：可以从 `Channel` 中读取数据到 `Buffer`，也可以将数据从 `Buffer` 写入到 `Channel`。以下是这一过程的示意图：  

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1729842186345-afe581a4-5eaf-41e7-b2c4-1eaf76de1e86.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

通常来说, 所有的 NIO 的 I/O 操作都是从 Channel 开始的. 一个 channel 类似于一个 stream. java Stream 和 NIO Channel 对比

- 我们可以在同一个 Channel 中执行读和写操作, 然而同一个 Stream 仅仅支持读或写.
- Channel 可以异步地读写, 而 Stream 是阻塞的同步读写.
- Channel 总是从 Buffer 中读取数据, 或将数据写入到 Buffer 中



在 Java NIO 中，有多种 `Channel` 和 `Buffer` 类型。以下是 Java NIO 中主要的 `Channel` 实现列表：

1. **FileChannel**：用于从文件中读取或写入数据的通道。
2. **DatagramChannel**：用于通过 UDP 读取和写入网络数据。
3. **SocketChannel**：用于通过 TCP 读取和写入网络数据的通道，适用于单个客户端到服务器的连接。
4. **ServerSocketChannel**：允许监听新进来的 TCP 连接，对每个连接创建一个 `SocketChannel`。

正如所见，这些通道涵盖了 UDP 和 TCP 网络 IO 以及文件 IO。

在这些类的基础上，还存在一些有趣的接口，不过为了保持简单性，我会将它们从本次 Java NIO 概述中排除。它们将在本教程的其他部分中进行详细说明。

以下是 Java NIO 中核心 `Buffer` 实现的列表：

- **ByteBuffer**：用于存储字节数据，是最常用的 `Buffer` 类型，支持多种基本数据类型的读写操作。
- **CharBuffer**：用于存储字符数据，适合字符数据的读写操作。
- **ShortBuffer**：用于存储 `short` 类型的数据。
- **IntBuffer**：用于存储 `int` 类型的数据。
- **LongBuffer**：用于存储 `long` 类型的数据。
- **FloatBuffer**：用于存储 `float` 类型的数据。
- **DoubleBuffer**：用于存储 `double` 类型的数据。

这些 `Buffer` 涵盖了您可以通过 IO 发送的基本数据类型：`byte`、`short`、`int`、`long`、`float`、`double` 和字符。

Java NIO 还有一个 `MappedByteBuffer`，用于与内存映射文件结合使用。不过，我会将这个 `Buffer` 排除在本次概述之外。

### Selectors

一个 `Selector` 允许一个线程处理多个 `Channel`。如果您的应用程序有许多打开的连接（`Channel`），但每个连接的流量都很低，这种方式非常方便。例如，在一个聊天服务器中。

下面是一个使用 `Selector` 来处理 3 个 `Channel` 的线程示意图：

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1729842435121-75086f86-d44e-49d7-9f9c-7cbd9e8bb666.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

 要使用 `Selector`，您需要将 `Channel` 注册到它。然后调用它的 `select()` 方法。该方法将阻塞，直到其中一个注册的通道有事件准备好。一旦该方法返回，线程就可以处理这些事件。事件的示例包括传入的连接、接收到的数据等。  

### Channel 如何做到异步？

例如，下图所示，我们使用 NIO 的 `Selector` 来监听多个 `Channel`。由于 `Channel` 既可以进行读操作也可以进行写操作，因此在监听时，`Selector` 并不需要像 BIO 一样，阻塞等待 `Channel` 有数据才返回。相反，`Channel` 可以主动通知 `Selector`，让其处理。这种方式使得 `Selector` 不需要阻塞，从而实现了 `Channel` 的异步特性。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730098967983-57437fbf-db0c-4164-a7dc-b2b1dce1776f.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

最明显的区别在于：一个是**阻塞读取**，一个是**到达读取**。

- **Stream** 是 BIO，即阻塞模式，分为输入（IN）和输出（OUT）。无论是输入还是输出，在进行消息处理时，当前线程都会被阻塞，必须等待对方的数据到达。
- **Channel** 是 NIO，可以理解为包含了输入和输出的通道概念。`Channel` 的实现有很多，针对本地文件、网络或内存等不同场景，其表现并不完全相同。

可以理解为：`Channel` 的数据消费过程是将数据写入缓冲区（`Buffer`），或从缓冲区读取数据；这个过程可以通过 `Selector` 来辅助监听 `Channel` 的状态。

## Java NIO Channel

Java NIO 通道与流类似，但有一些不同之处：

- 您可以对通道进行读写操作，而流通常是单向的（只读或只写）。
- 通道可以异步地进行读写。
- 通道始终是从缓冲区读取或向缓冲区写入数据。

正如上面所提到的，您可以从通道读取数据到缓冲区，也可以从缓冲区写入数据到通道。以下是相关的说明：

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729842570357-445b0041-84af-4574-aa65-3c273c677bbe.png)

### Channel的实现类

以下是 Java NIO 中最重要的通道实现：

- **FileChannel**：用于从文件中读取数据或向文件写入数据。
- **DatagramChannel**：可以通过 UDP 在网络上读取和写入数据。
- **SocketChannel**：可以通过 TCP 在网络上读取和写入数据。
- **ServerSocketChannel**：允许您监听传入的 TCP 连接，就像 Web 服务器一样。对于每个传入的连接，会创建一个 SocketChannel。

### 简单的 Channel 例子

这里有一个简单的举例：使用 FileChannel 去读取数据到 Buffer 中

```java
RandomAccessFile aFile = new RandomAccessFile("data/nio-data.txt", "rw");
FileChannel inChannel = aFile.getChannel();

ByteBuffer buf = ByteBuffer.allocate(48);

int bytesRead = inChannel.read(buf);
while (bytesRead != -1) {

    System.out.println("Read " + bytesRead);
    buf.flip();

    while(buf.hasRemaining()){
        System.out.print((char) buf.get());
    }

    buf.clear();
    bytesRead = inChannel.read(buf);
}
aFile.close();
```

请注意 `buf.flip()` 的调用。首先，您将数据读取到一个缓冲区中。然后，您调用 `flip()` 方法，接着再从缓冲区中读取数据。在接下来的关于缓冲区的文本中，我会详细讲解这一点。

## Java NIO Buffer

Java NIO 缓冲区用于与 NIO 通道交互。正如您所知道的，数据是从通道读取到缓冲区中，然后从缓冲区写入到通道中。

缓冲区本质上是一个内存块，您可以在其中写入数据，然后稍后再读取这些数据。这个内存块被封装在一个 NIO Buffer 对象中，该对象提供了一组方法，使得操作内存块变得更加简单。

### 基本的缓冲区使用

使用缓冲区读取和写入数据通常遵循以下四个步骤：

1. 将数据写入缓冲区
2. 调用 `buffer.flip()`
3. 从缓冲区读取数据
4. 调用 `buffer.clear()` 或 `buffer.compact()`

当您将数据写入缓冲区时，缓冲区会跟踪您写入了多少数据。一旦您需要读取数据，您需要通过调用 `flip()` 方法将缓冲区从写入模式切换到读取模式。在读取模式下，缓冲区允许您读取所有写入的数据。

一旦您读取完所有数据，就需要清空缓冲区，以便再次准备好进行写入。您可以通过两种方式来实现这一点：调用 `clear()` 或调用 `compact()`。`clear()` 方法会清空整个缓冲区，而 `compact()` 方法仅清除您已经读取的数据。任何未读取的数据将被移动到缓冲区的开头，数据将写入未读取数据之后的缓冲区中。

下面是一个简单的缓冲区使用示例：

```java
RandomAccessFile aFile = new RandomAccessFile("data/nio-data.txt", "rw");
FileChannel inChannel = aFile.getChannel();

//create buffer with capacity of 48 bytes
ByteBuffer buf = ByteBuffer.allocate(48);

int bytesRead = inChannel.read(buf); //read into buffer.
while (bytesRead != -1) {

    buf.flip();  //make buffer ready for read

    while(buf.hasRemaining()){
        System.out.print((char) buf.get()); // read 1 byte at a time
    }

    buf.clear(); //make buffer ready for writing
    bytesRead = inChannel.read(buf);
}
aFile.close();
```

### Buffer Capacity, Position and Limit

缓冲区本质上是一个内存块，您可以在其中写入数据，然后再读取这些数据。这个内存块被包装在 NIO Buffer 对象中，该对象提供了一组方法，使您更容易地操作该内存块。

要理解缓冲区的工作原理，您需要熟悉缓冲区的三个属性，它们分别是：

- **容量 (capacity)**
- **位置 (position)**
- **限制 (limit)**

位置和限制的含义取决于缓冲区是处于读取模式还是写入模式。容量在任何缓冲区模式下始终具有相同的含义。

以下是一个在写入模式和读取模式下展示容量、位置和限制的示例，说明将在示例后的各个部分中进行解释。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1729842892893-0f0842e5-b266-4908-bf69-701f96936a5b.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1)

**容量 (Capacity)**

作为一个内存块，缓冲区具有一定的固定大小，也称为“容量”。您只能向缓冲区中写入容量大小的字节、长整型、字符等。一旦缓冲区满了，您需要先清空它（读取数据或清除缓冲区），然后才能写入更多数据。

**位置 (Position)**

当您向缓冲区写入数据时，您是在某个特定的位置进行写入。初始时，位置为 0。当一个字节、长整型等被写入缓冲区后，位置会向前推进，指向缓冲区中下一个插入数据的单元格。位置的最大值为容量 - 1。

当您从缓冲区读取数据时，您也是从某个特定的位置开始读取。当将缓冲区从写入模式切换到读取模式时，位置会重置为 0。随着您从缓冲区读取数据，位置会推进到下一个读取位置。

**限制 (Limit)**

在写入模式下，缓冲区的限制是您可以写入缓冲区的数据量的上限。在写入模式下，限制等于缓冲区的容量。

当将缓冲区切换到读取模式时，限制表示您可以从数据中读取的数量的上限。因此，在将缓冲区切换到读取模式时，限制会设置为写入模式下的写入位置。换句话说，您可以读取的字节数与已写入的字节数相同（限制被设置为已写入的字节数，由位置标记）。

### 缓冲区类型 (Buffer Types)

Java NIO 提供了以下缓冲区类型：

- **ByteBuffer**
- **MappedByteBuffer**
- **CharBuffer**
- **DoubleBuffer**
- **FloatBuffer**
- **IntBuffer**
- **LongBuffer**
- **ShortBuffer**

如您所见，这些缓冲区类型表示不同的数据类型。换句话说，它们允许您将缓冲区中的字节作为字符、短整型、整型、长整型、浮点型或双精度浮点型来处理。

**MappedByteBuffer** 是一种特殊的缓冲区，将在独立的文本中讨论。

### 分配缓冲区 (Allocating a Buffer)

要获得一个缓冲区对象，您必须首先分配它。每个缓冲区类都有一个 `allocate()` 方法来完成这一操作。以下是一个示例，展示如何分配一个容量为 48 字节的 `ByteBuffer`：

```java
ByteBuffer buf = ByteBuffer.allocate(48);
```

以下是分配一个容量为 1024 个字符的 `CharBuffer` 的示例：

```java
CharBuffer buf = CharBuffer.allocate(1024);
```

### 向缓冲区写入数据 (Writing Data to a Buffer)

您可以通过两种方式向缓冲区写入数据：

1. 从通道 (Channel) 中读取数据到缓冲区。
2. 通过缓冲区的 `put()` 方法手动写入数据。

以下是一个示例，展示如何从通道向缓冲区写入数据：

```java
int bytesRead = inChannel.read(buf); // 从通道读取数据到缓冲区
```

以下是一个通过 `put()` 方法向缓冲区写入数据的示例：

```java
buf.put(127);
```

`put()` 方法有许多不同的版本，允许您以多种不同的方式向缓冲区写入数据。例如，可以在特定位置写入或将字节数组写入缓冲区。有关更多详细信息，请参阅具体缓冲区实现的 JavaDoc。

### flip()

`flip()` 方法将缓冲区从写入模式切换到读取模式。调用 `flip()` 会将位置重置为 0，并将限制设置为刚才的位置。

换句话说，位置现在标记为读取位置，而限制标记为缓冲区中写入的字节、字符等的数量——即可以读取的字节、字符等的限制。

### 从缓冲区读取数据 (Reading Data from a Buffer)

您可以通过两种方式从缓冲区读取数据：

1. 从缓冲区读取数据到通道。
2. 使用其中一个 `get()` 方法从缓冲区读取数据。

以下是一个示例，展示如何从缓冲区读取数据到通道：

```java
int bytesWritten = inChannel.write(buf);
```

以下是一个使用 `get()` 方法从缓冲区读取数据的示例：

```java
byte aByte = buf.get();
```

`get()` 方法有许多不同的版本，允许您以多种不同的方式从缓冲区读取数据。例如，可以在特定位置读取或从缓冲区读取字节数组。有关更多详细信息，请参阅具体缓冲区实现的 JavaDoc。

### rewind()

`Buffer.rewind()` 将位置重置为 0，以便您可以重新读取缓冲区中的所有数据。限制保持不变，因此仍然标记可从缓冲区读取的元素数量（字节、字符等）。

### clear() 和 compact()

一旦您完成了从缓冲区读取数据，您必须使缓冲区准备好再次写入。您可以通过调用 `clear()` 或 `compact()` 来实现。

如果您调用 `clear()`，位置将重置为 0，限制设置为容量。换句话说，缓冲区被清空。缓冲区中的数据不会被清除。只有指示您可以将数据写入缓冲区的位置标记会被重置。

如果在调用 `clear()` 时缓冲区中还有未读数据，该数据将“被遗忘”，这意味着您不再有任何标记来指示哪些数据已被读取，哪些未被读取。

如果缓冲区中仍然有未读数据，并且您希望稍后读取它，但需要先进行一些写入，请调用 `compact()` 而不是 `clear()`。

`compact()` 会将所有未读数据复制到缓冲区的开头。然后将位置设置为最后一个未读元素之后的位置。限制属性仍设置为容量，正如 `clear()` 所做的那样。现在缓冲区准备好写入，但您不会覆盖未读数据。

### mark() 和 reset()

您可以通过调用 `Buffer.mark()` 方法标记缓冲区中的给定位置。然后，您可以通过调用 `Buffer.reset()` 方法将位置重置回标记的位置。以下是一个示例：

```java
buffer.mark();

// 调用 buffer.get() 多次，例如在解析期间。

buffer.reset();  // 将位置重置回标记
```

## Java NIO Scatter / Gather

Java NIO 内置了 scatter/gather 支持。scatter/gather 是用于从通道读取和写入的概念。

从通道的 scattering 读取是将数据读取到多个缓冲区的读取操作。因此，通道将数据“分散”到多个缓冲区中。

对通道的 gathering 写入是将多个缓冲区的数据写入单个通道的写入操作。因此，通道将来自多个缓冲区的数据“汇聚”到一个通道中。

scatter/gather 在需要单独处理传输数据的各个部分的情况下非常有用。例如，如果一条消息由头部和主体组成，您可以将头部和主体分别放在不同的缓冲区中。这样做可能使您更容易分别处理头部和主体。

### Scattering Reads

“散射读取”是从单个通道读取数据到多个缓冲区。以下是该原理的示意图：

这里是散射原理的示意图：

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729843341604-1247dba2-37ac-4aba-bb52-6a42495ee773.png)

以下是一个示例代码，演示如何执行散射读取：

```java
ByteBuffer header = ByteBuffer.allocate(128);
ByteBuffer body = ByteBuffer.allocate(1024);

ByteBuffer[] bufferArray = { header, body };

channel.read(bufferArray);
```

请注意，缓冲区首先被插入到一个数组中，然后该数组作为参数传递给 `channel.read()` 方法。`read()` 方法按照数组中缓冲区的顺序从通道中写入数据。一旦一个缓冲区满了，通道将继续填充下一个缓冲区。

散射读取填满一个缓冲区后再移动到下一个缓冲区，这意味着它不适合动态大小的消息部分。换句话说，如果您有一个固定大小的头部（例如128字节）和一个主体，则散射读取工作良好。

### Gathering Writes

 “聚集写入”将来自多个缓冲区的数据写入单个通道。以下是该原则的说明：  

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729843418781-a15ee703-c8c6-45dd-b8d0-460b47521431.png)

以下是一个示例代码，演示如何执行聚集写入：

```java
ByteBuffer header = ByteBuffer.allocate(128);
ByteBuffer body   = ByteBuffer.allocate(1024);

// 向通道写入数据

ByteBuffer[] bufferArray = { header, body };

channel.write(bufferArray);
```

缓冲区数组作为参数传递给 `write()` 方法，该方法按照数组中遇到的顺序写入缓冲区的内容。只有在缓冲区的当前位置和限制之间的数据会被写入。因此，如果一个缓冲区的容量为 128 字节，但只包含 58 字节，则仅从该缓冲区向通道写入 58 字节。因此，与分散读取不同，聚集写入可以很好地处理动态大小的消息部分。

## Java NIO Channel to Channel Transfers

 在 Java NIO 中，您可以直接将数据从一个通道传输到另一个通道，如果其中一个通道是 `FileChannel`。`FileChannel` 类提供了 `transferTo()` 和 `transferFrom()` 方法来完成这一操作。  

### transferFrom()

`FileChannel.transferFrom()` 方法将数据从源通道传输到 `FileChannel`。以下是一个简单的示例：

```java
RandomAccessFile fromFile = new RandomAccessFile("fromFile.txt", "rw");
FileChannel      fromChannel = fromFile.getChannel();

RandomAccessFile toFile = new RandomAccessFile("toFile.txt", "rw");
FileChannel      toChannel = toFile.getChannel();

long position = 0;
long count    = fromChannel.size();

toChannel.transferFrom(fromChannel, position, count);
```

参数 `position` 和 `count` 指定了在目标文件中开始写入的位置（`position`）以及要最大传输的字节数（`count`）。如果源通道的字节数少于 `count`，则实际传输的字节数会更少。

此外，一些 `SocketChannel` 实现可能仅会传输 `SocketChannel` 内部缓冲区中当前可用的数据，即使 `SocketChannel` 后续可能会有更多数据可用。因此，它可能不会将请求的整个数据（`count`）从 `SocketChannel` 传输到 `FileChannel`。

### transferTo()

`transferTo()` 方法用于将数据从 `FileChannel` 传输到其他通道。以下是一个简单的示例：

```java
RandomAccessFile fromFile = new RandomAccessFile("fromFile.txt", "rw");
FileChannel      fromChannel = fromFile.getChannel();

RandomAccessFile toFile = new RandomAccessFile("toFile.txt", "rw");
FileChannel      toChannel = toFile.getChannel();

long position = 0;
long count    = fromChannel.size();

fromChannel.transferTo(position, count, toChannel);
```

注意，这个示例与前一个示例非常相似。唯一的实际区别是调用方法的 `FileChannel` 对象。其他部分是相同的。

在 `transferTo()` 方法中，`SocketChannel` 的问题也存在。`SocketChannel` 实现可能只会从 `FileChannel` 传输字节，直到发送缓冲区已满，然后停止

## Java NIO Selector 概述

Java NIO 的 `Selector` 是一个组件，可以检查一个或多个 Java NIO 通道实例，确定哪些通道准备好进行读取或写入等操作。通过这种方式，单个线程可以管理多个通道，从而管理多个网络连接。

### 为什么使用 Selector？

使用单个线程处理多个通道的优势在于，您需要的线程数量更少。实际上，您可以仅使用一个线程来处理所有通道。线程之间的切换对于操作系统来说是昂贵的，每个线程也会在操作系统中占用一些资源（内存）。因此，您使用的线程越少，效果越好。

不过请记住，现代操作系统和 CPU 在多任务处理方面越来越出色，因此多线程的开销随着时间的推移而变小。实际上，如果 CPU 有多个核心，您可能会因不进行多任务处理而浪费 CPU 功率。不过，这种设计讨论属于其他主题。可以简单地说，您可以使用 Selector 用单个线程处理多个通道。

### 创建 Selector

您可以通过调用 `Selector.open()` 方法来创建一个 `Selector`：

```java
Selector selector = Selector.open();
```

### 将通道注册到 Selector

要使用通道与 Selector，必须将通道注册到 Selector。这是通过 `SelectableChannel.register()` 方法完成的，示例如下：

```java
channel.configureBlocking(false);
SelectionKey key = channel.register(selector, SelectionKey.OP_READ);
```

通道必须处于非阻塞模式才能与 Selector 一起使用。这意味着您不能将 `FileChannel` 与 Selector 一起使用，因为 `FileChannel` 无法切换到非阻塞模式。而 `SocketChannel` 则可以正常工作。

请注意 `register()` 方法的第二个参数。这是一个“兴趣集”，表示您希望通过 Selector 监听的通道事件。您可以监听四种不同的事件：

- **连接（Connect）**
- **接收（Accept）**
- **读取（Read）**
- **写入（Write）**

“触发事件”的通道也称为“准备好”该事件。因此，成功连接到另一台服务器的通道被视为“连接准备好”。接受传入连接的服务器套接字通道被视为“接收准备好”。有数据准备读取的通道被视为“读取准备好”。准备好接收数据写入的通道被视为“写入准备好”。

这四个事件由四个 `SelectionKey` 常量表示：

- `SelectionKey.OP_CONNECT`
- `SelectionKey.OP_ACCEPT`
- `SelectionKey.OP_READ`
- `SelectionKey.OP_WRITE`

如果您对多个事件感兴趣，可以通过按位或操作将常量结合起来，例如：

```java
int interestSet = SelectionKey.OP_READ | SelectionKey.OP_WRITE;
```

### SelectionKey

如前面所述，当您将通道注册到 Selector 时，`register()` 方法返回一个 `SelectionKey` 对象。该 `SelectionKey` 对象包含一些有趣的属性：

- **兴趣集（Interest Set）**
- **就绪集（Ready Set）**
- **通道（Channel）**
- **选择器（Selector）**
- **附加对象（可选）**

以下是这些属性的详细说明。

#### 兴趣集

兴趣集是您感兴趣的“选择”事件集合，如“将通道注册到 Selector”部分所述。您可以通过 `SelectionKey` 读取和写入该兴趣集，如下所示：

```java
int interestSet = selectionKey.interestOps();

boolean isInterestedInAccept  = SelectionKey.OP_ACCEPT  == (interestSet & SelectionKey.OP_ACCEPT);
boolean isInterestedInConnect = SelectionKey.OP_CONNECT == (interestSet & SelectionKey.OP_CONNECT);
boolean isInterestedInRead    = SelectionKey.OP_READ    == (interestSet & SelectionKey.OP_READ);
boolean isInterestedInWrite   = SelectionKey.OP_WRITE   == (interestSet & SelectionKey.OP_WRITE);
```

如您所见，您可以使用给定的 `SelectionKey` 常量与兴趣集进行按位与运算，以确定特定事件是否在兴趣集中。

#### 就绪集

就绪集是通道准备好的操作集合。您将主要在选择后访问就绪集。选择将在后面的部分进行解释。您可以像这样访问就绪集：

```java
int readySet = selectionKey.readyOps();
```

您可以使用与兴趣集相同的方式测试通道准备好的事件/操作。不过，您还可以使用以下四个方法，这些方法都会返回布尔值：

```java
selectionKey.isAcceptable();
selectionKey.isConnectable();
selectionKey.isReadable();
selectionKey.isWritable();
```

#### 通道和选择器

从 `SelectionKey` 访问通道和选择器非常简单。以下是获取方法：

```java
Channel channel  = selectionKey.channel();
Selector selector = selectionKey.selector();
```

#### 附加对象

您可以将对象附加到 `SelectionKey`，这是识别给定通道或附加更多信息的一种便利方法。例如，您可以附加与通道一起使用的缓冲区，或包含更多汇总数据的对象。附加对象的方法如下：

```java
selectionKey.attach(theObject);

Object attachedObj = selectionKey.attachment();
```

您还可以在将通道注册到选择器时，在 `register()` 方法中同时附加对象。示例如下：

```java
SelectionKey key = channel.register(selector, SelectionKey.OP_READ, theObject);
```

### 通过 Selector 选择通道

一旦您将一个或多个通道注册到 Selector，您就可以调用其中一个 `select()` 方法。这些方法会返回“准备好”进行您感兴趣的事件（连接、接收、读取或写入）的通道。换句话说，如果您对准备好读取的通道感兴趣，您将从 `select()` 方法接收准备好读取的通道。

以下是 `select()` 方法：

```java
int select()
int select(long timeout)
int selectNow()
```

- `select()` 会阻塞，直到至少有一个通道准备好进行您注册的事件。
- `select(long timeout)` 与 `select()` 的功能相同，但最大阻塞时间为超时时间（参数指定）。
- `selectNow()` 完全不阻塞。它会立即返回准备好的通道。

`select()` 方法返回的整数值表示有多少通道准备好了。这意味着，自上次调用 `select()` 以来，有多少通道变为准备好。如果您调用 `select()` 并且返回 1，表示有一个通道变为准备好；如果您再调用一次 `select()`，并且又有一个通道变为准备好，它将再次返回 1。如果您在处理第一个准备好的通道时没有对其进行任何操作，则现在有 2 个准备好的通道，但在每次 `select()` 调用之间仅有一个通道变为准备好。

### selectedKeys()

一旦您调用了其中一个 `select()` 方法，并且返回值表明一个或多个通道已准备好，您可以通过调用选择器的 `selectedKeys()` 方法访问准备好的通道。如下所示：

```java
Set<SelectionKey> selectedKeys = selector.selectedKeys();
```

当您将通道注册到 Selector 时，`Channel.register()` 方法返回一个 `SelectionKey` 对象。该键表示通道与该选择器的注册关系。您可以通过 `selectedKeys()` 方法访问这些键。

您可以迭代此选定键集以访问准备好的通道。如下所示：

```java
Set<SelectionKey> selectedKeys = selector.selectedKeys();
Iterator<SelectionKey> keyIterator = selectedKeys.iterator();

while(keyIterator.hasNext()) {
    SelectionKey key = keyIterator.next();

    if(key.isAcceptable()) {
        // ServerSocketChannel 接受了一个连接。
    } else if (key.isConnectable()) {
        // 与远程服务器建立了连接。
    } else if (key.isReadable()) {
        // 通道准备好读取。
    } else if (key.isWritable()) {
        // 通道准备好写入。
    }

    keyIterator.remove();
}
```

该循环迭代选定键集中的键。对于每个键，它测试该键以确定所引用的通道准备好了什么。

请注意，在每次迭代结束时调用的 `keyIterator.remove()`。选择器不会自动从选定键集中删除 `SelectionKey` 实例。您必须在完成通道处理后手动删除。下次通道变为“准备好”时，选择器将再次将其添加到选定键集中。

通过 `SelectionKey.channel()` 方法返回的通道应该转换为您需要处理的通道，例如 `ServerSocketChannel` 或 `SocketChannel` 等。

### wakeUp()

调用 `select()` 方法并被阻塞的线程，可以通过在其他线程上调用该选择器的 `Selector.wakeup()` 方法使其离开 `select()` 方法，即使没有通道准备好。等待在 `select()` 内部的线程将立即返回。

如果另一个线程调用 `wakeup()`，而当前没有线程被阻塞在 `select()` 内，则下一个调用 `select()` 的线程将立即“唤醒”。

### close()

完成对选择器的使用后，调用其 `close()` 方法。这将关闭选择器并使所有与

### 完整的例子

```java
Selector selector = Selector.open();

channel.configureBlocking(false);

SelectionKey key = channel.register(selector, SelectionKey.OP_READ);


while(true) {

  int readyChannels = selector.selectNow();

  if(readyChannels == 0) continue;


  Set<SelectionKey> selectedKeys = selector.selectedKeys();

  Iterator<SelectionKey> keyIterator = selectedKeys.iterator();

  while(keyIterator.hasNext()) {

    SelectionKey key = keyIterator.next();

    if(key.isAcceptable()) {
        // a connection was accepted by a ServerSocketChannel.

    } else if (key.isConnectable()) {
        // a connection was established with a remote server.

    } else if (key.isReadable()) {
        // a channel is ready for reading

    } else if (key.isWritable()) {
        // a channel is ready for writing
    }

    keyIterator.remove();
  }
}
```

所谓通道的读取，就是将数据从通道读取到缓冲区中；所谓通道的写入，就是将数据从缓冲区中写入到通道中。缓冲区的使用，是面向流进行读写操作的OIO所没有的，也是NIO非阻塞的重要前提和基础之一。

#### 详解 NIO Buffer 类及其属性

NIO的Buffer（缓冲区）本质上是一个内存块，既可以写入数据，也可以从中读取数据。Java NIO中代表缓冲区的Buffer类是一个抽象类，位于java.nio包中。

NIO的Buffer的内部是一个内存块（数组），此类与普通的内存块（Java数组）不同的是：NIO Buffer对象，提供了一组比较有效的方法，用来进行写入和读取的交替访问。

Buffer类是一个非线程安全类。

## NIO 实战

### 文件操作

```java
while (channel.read(buf) != -1){ // 读取通道中的数据，并写入到 buf 中
    buf.flip(); // 缓存区切换到读模式
    while (buf.position() < buf.limit()){ // 读取 buf 中的数据
        text.append((char)buf.get());
    }
    buf.clear(); // 清空 buffer，缓存区切换到写模式
}
for (int i = 0; i < text.length(); i++) {
    buf.put((byte)text.charAt(i)); // 填充缓冲区，需要将 2 字节的 char 强转为 1 自己的 byte
    if (buf.position() == buf.limit() || i == text.length() - 1) { // 缓存区已满或者已经遍历到最后一个字符
        buf.flip(); // 将缓冲区由写模式置为读模式
        channel.write(buf); // 将缓冲区的数据写到通道
        buf.clear(); // 清空缓存区，将缓冲区置为写模式，下次才能使用
    }
}
```

### 网络通信

**NIOServer**

```java
public static void main(String[] args) throws  Exception{
    //创建ServerSocketChannel，-->> ServerSocket
    ServerSocketChannel serverSocketChannel = ServerSocketChannel.open();
    InetSocketAddress inetSocketAddress = new InetSocketAddress(5555);
    serverSocketChannel.socket().bind(inetSocketAddress);
    serverSocketChannel.configureBlocking(false); //设置成非阻塞

    //开启selector,并注册accept事件
    Selector selector = Selector.open();
    serverSocketChannel.register(selector, SelectionKey.OP_ACCEPT);

    while(true) {
        selector.select(2000);  //监听所有通道
        //遍历selectionKeys
        Set<SelectionKey> selectionKeys = selector.selectedKeys();
        Iterator<SelectionKey> iterator = selectionKeys.iterator();
        while (iterator.hasNext()) {
            SelectionKey key = iterator.next();
            if(key.isAcceptable()) {  //处理连接事件
                SocketChannel socketChannel = serverSocketChannel.accept();
                socketChannel.configureBlocking(false);  //设置为非阻塞
                System.out.println("client:" + socketChannel.getLocalAddress() + " is connect");
                socketChannel.register(selector, SelectionKey.OP_READ); //注册客户端读取事件到selector
            } else if (key.isReadable()) {  //处理读取事件
                ByteBuffer byteBuffer = ByteBuffer.allocate(1024);
                SocketChannel channel = (SocketChannel) key.channel();
                channel.read(byteBuffer);
                System.out.println("client:" + channel.getLocalAddress() + " send " + new String(byteBuffer.array()));
            }
            iterator.remove();  //事件处理完毕，要记得清除
        }
    }

}
```

**NIOClient**

```java
public class NIOClient {

public static void main(String[] args) throws Exception{
    SocketChannel socketChannel = SocketChannel.open();
    socketChannel.configureBlocking(false);
    InetSocketAddress inetSocketAddress = new InetSocketAddress("127.0.0.1", 5555);

    if(!socketChannel.connect(inetSocketAddress)) {
        while (!socketChannel.finishConnect()) {
            System.out.println("客户端正在连接中，请耐心等待");
        }
    }

    ByteBuffer byteBuffer = ByteBuffer.wrap("mikechen的互联网架构".getBytes());
    socketChannel.write(byteBuffer);
    socketChannel.close();
}
```

## Netty 如何加强 Java NIO

[以 Java NIO 的角度去理解 Netty-腾讯云开发者社区-腾讯云](https://cloud.tencent.com/developer/article/2381540)

我们从这篇文章就可以看出 Netty 底层其实还是 JDK NIO这一套

那么我们再深入看看 Netty 在 JDK NIO 之上又做了什么

可以这么说，Netty 需要加强JDK NIO以实现它的Reactor模型，但是具体怎么加强的，请跟随笔者。

在 Netty 里面任然保留了 Channel Selector Buffer 这几个 NIO 的核心概念



下图是NIO的核心概念

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729839184764-66e9e47f-dc0f-4e06-af6d-b98cce451ef7.png)



上述的 Thread 对应于 Netty 的 主从 Reactor 模型中的 Reactor

然后我们看看 Netty 还需要什么

1. 需要一个主从 Reactor Group 去管理 Reactor
2. 需要将 处理器链（Pipline）注册到 Channel 上，以实现我们的具体业务逻辑
3. Reactor线程不止处理IO事件，还有异步任务、定时任务。。

所以我们可以得到下图：Netty 架构图



![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1729839393448-11d67190-2774-4222-ba61-53b697f6abca.png)