# 从内核角度看 IO 模型

## 前言

我们来看下 Netty 官网首页的简介，

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730004384512-218a7b37-ac5a-446c-8eec-d9cab6a440aa.png)

**上述文字段翻译后为：**

> - **Netty** 是一个异步事件驱动的网络应用框架，旨在快速开发可维护的高性能协议服务器和客户端。
> - **Netty** 是一个 NIO 客户端-服务器框架，能够快速且轻松地开发网络应用程序，如协议服务器和客户端。它极大地简化和优化了网络编程，例如 TCP 和 UDP 套接字服务器。
> - “快速和轻松” 并不意味着最终应用会遭受可维护性或性能问题。**Netty** 在设计时充分借鉴了实现众多协议（如 **FTP**、**SMTP**、**HTTP** 以及各种基于二进制和文本的传统协议）的经验。因此，**Netty** 成功地找到了在开发便捷性、性能、稳定性和灵活性之间实现平衡的方法，没有任何妥协。

我们可以推测出 **Netty** 这个框架的高性能有很大部分源于其底层模型：

- **IO 模型**：NIO，当然你也可以用其他的，但主要还是 NIO。
- **IO 线程模型**：Reactor 模型。

所以本文和 [IO 多路复用](/netty_source_code_parsing/network_program/io_multiplexing) 旨在说明这两部分的内容

## 网络包接收流程

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311206411.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_se,x_1,y_1" alt="image-20241031120605304" style="zoom: 33%;" />

### 性能开销

- 应用程序通过 系统调用 从 用户态 转为 内核态 的开销，以及系统调用返回时从内核态转为用户态的开销
- 网络数据从内核空间通过 CPU 拷贝到用户空间的开销
- 内核线程 `ksoftirqd` 响应软中断的开销
- CPU 响应硬中断的开销
- DMA 拷贝网络数据包到内存中的开销

-

## 再谈【阻塞&非阻塞】与【同步&异步】

经过前边对网络数据包接收流程的介绍，在这里我们可以将整个流程总结为两个阶段：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311427739.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031142717645" style="zoom: 33%;" />

- **数据准备阶段：** 在这个阶段，网络数据包到达网卡，通过`DMA`的方式将数据包拷贝到内存中，然后经过硬中断，软中断，接着通过内核线程`ksoftirqd`经过内核协议栈的处理，最终将数据发送到`内核Socket`的接收缓冲区中。
- **数据拷贝阶段：** 当数据到达`内核Socket`的接收缓冲区中时，此时数据存在于`内核空间`中，需要将数据`拷贝`到`用户空间`中，才能够被应用程序读取。

### 阻塞&非阻塞

阻塞与非阻塞的区别主要发生在第一阶段：`数据准备阶段`。

当应用程序发起`系统调用read`时，线程从用户态转为内核态，读取内核`Socket`的接收缓冲区中的网络数据。

#### 阻塞

如果这时内核`Socket`的接收缓冲区没有数据，那么线程就会一直`等待`，直到`Socket`接收缓冲区有数据为止。随后将数据从内核空间拷贝到用户空间，`系统调用read`返回。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311427603.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031142741514" style="zoom: 33%;" />

从图中我们可以看出：**阻塞**的特点是在第一阶段和第二阶段`都会等待`。

#### 非阻塞

`阻塞`和`非阻塞`主要的区分是在第一阶段：`数据准备阶段`。

- 在第一阶段，当`Socket`的接收缓冲区中没有数据的时候，`阻塞模式下`应用线程会一直等待。`非阻塞模式下`应用线程不会等待，`系统调用`直接返回错误标志`EWOULDBLOCK`。
- 当`Socket`的接收缓冲区中有数据的时候，`阻塞`和`非阻塞`的表现是一样的，都会进入第二阶段`等待`数据从`内核空间`拷贝到`用户空间`，然后`系统调用返回`。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311427971.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031142753869" style="zoom:33%;" />

从上图中，我们可以看出：**非阻塞**的特点是第一阶段`不会等待`，但是在第二阶段还是会`等待`。

### 同步&异步

`同步`与`异步`主要的区别发生在第二阶段：`数据拷贝阶段`。

前边我们提到在`数据拷贝阶段`主要是将数据从`内核空间`拷贝到`用户空间`。然后应用程序才可以读取数据。

当内核`Socket`的接收缓冲区有数据到达时，进入第二阶段。

#### 同步

`同步模式`在数据准备好后，是由`用户线程`的`内核态`来执行`第二阶段`。所以应用程序会在第二阶段发生`阻塞`，直到数据从`内核空间`拷贝到`用户空间`，系统调用才会返回。

Linux 下的 `epoll`和 Mac 下的 `kqueue`都属于`同步 IO`。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311235936.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_ne,x_1,y_1" alt="image-20241031123517877" style="zoom:33%;" />

#### 异步

`异步模式`下是由`内核`来执行第二阶段的数据拷贝操作，当`内核`执行完第二阶段，会通知用户线程 IO 操作已经完成，并将数据回调给用户线程。所以在`异步模式`下 `数据准备阶段`和`数据拷贝阶段`均是由`内核`来完成，不会对应用程序造成任何阻塞。

基于以上特征，我们可以看到`异步模式`需要内核的支持，比较依赖操作系统底层的支持。

在目前流行的操作系统中，只有 Windows 中的 `IOCP`才真正属于异步 IO，实现的也非常成熟。但 Windows 很少用来作为服务器使用。

而常用来作为服务器使用的 Linux，`异步IO机制`实现的不够成熟，与 NIO 相比性能提升的也不够明显。

但 Linux kernel 在 5.1 版本由 Facebook 的大神 Jens Axboe 引入了新的异步 IO 库`io_uring` 改善了原来 Linux native AIO 的一些性能问题。性能相比`Epoll`以及之前原生的`AIO`提高了不少，值得关注。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311429679.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_ne,x_1,y_1" alt="image-20241031142918615" style="zoom:33%;" />

## IO 模型

在进行网络 IO 操作时，用什么样的 IO 模型来读写数据将在很大程度上决定了网络框架的 IO 性能。所以 IO 模型的选择是构建一个高性能网络框架的基础。

在《UNIX 网络编程》一书中介绍了五种 IO 模型：`阻塞IO`,`非阻塞IO`,`IO多路复用`,`信号驱动IO`,`异步IO`，每一种 IO 模型的出现都是对前一种的升级优化。

### 阻塞 IO

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311431597.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031143122474" style="zoom:33%;" />

#### 阻塞读

当用户线程发起`read`系统调用，用户线程从用户态切换到内核态，在内核中去查看`Socket`接收缓冲区是否有数据到来。

- `Socket`接收缓冲区中`有数据`，则用户线程在内核态将内核空间中的数据拷贝到用户空间，系统 IO 调用返回。
- `Socket`接收缓冲区中`无数据`，则用户线程让出 CPU，进入`阻塞状态`。当数据到达`Socket`接收缓冲区后，内核唤醒`阻塞状态`中的用户线程进入`就绪状态`，随后经过 CPU 的调度获取到`CPU quota`进入`运行状态`，将内核空间的数据拷贝到用户空间，随后系统调用返回。

#### 阻塞写

当用户线程发起`send`系统调用时，用户线程从用户态切换到内核态，将发送数据从用户空间拷贝到内核空间中的`Socket`发送缓冲区中。

- 当`Socket`发送缓冲区能够容纳下发送数据时，用户线程会将全部的发送数据写入`Socket`缓冲区，然后执行在《网络包发送流程》这小节介绍的后续流程，然后返回。
- 当`Socket`发送缓冲区空间不够，无法容纳下全部发送数据时，用户线程让出 CPU,进入`阻塞状态`，直到`Socket`发送缓冲区能够容纳下全部发送数据时，内核唤醒用户线程，执行后续发送流程。

`阻塞IO`模型下的写操作做事风格比较硬刚，非得要把全部的发送数据写入发送缓冲区才肯善罢甘休。

#### 阻塞 IO 线程模型

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311431102.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031143156001" style="zoom:33%;" />

由于`阻塞IO`的读写特点，所以导致在`阻塞IO`模型下，每个请求都需要被一个独立的线程处理。一个线程在同一时刻只能与一个连接绑定。来一个请求，服务端就需要创建一个线程用来处理请求。

当客户端请求的并发量突然增大时，服务端在一瞬间就会创建出大量的线程，而创建线程是需要系统资源开销的，这样一来就会一瞬间占用大量的系统资源。

如果客户端创建好连接后，但是一直不发数据，通常大部分情况下，网络连接也`并不`总是有数据可读，那么在空闲的这段时间内，服务端线程就会一直处于`阻塞状态`，无法干其他的事情。CPU 也`无法得到充分的发挥`，同时还会`导致大量线程切换的开销`。

#### 适用场景

基于以上`阻塞IO模型`的特点，该模型只适用于`连接数少`，`并发度低`的业务场景。

比如公司内部的一些管理系统，通常请求数在 100 个左右，使用`阻塞IO模型`还是非常适合的。而且性能还不输 NIO。

该模型在 C10K 之前，是普遍被采用的一种 IO 模型。

### 非阻塞 IO

`阻塞IO模型`最大的问题就是一个线程只能处理一个连接，如果这个连接上没有数据的话，那么这个线程就只能阻塞在系统 IO 调用上，不能干其他的事情

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311432287.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031143225187" style="zoom:33%;" />

#### 阻塞读

当用户线程发起非阻塞`read`系统调用时，用户线程从`用户态`转为`内核态`，在内核中去查看`Socket`接收缓冲区是否有数据到来。

- `Socket`接收缓冲区中`无数据`，系统调用立马返回，并带有一个 `EWOULDBLOCK` 或 `EAGAIN`错误，这个阶段用户线程`不会阻塞`，也`不会让出CPU`，而是会继续`轮训`直到`Socket`接收缓冲区中有数据为止。
- `Socket`接收缓冲区中`有数据`，用户线程在`内核态`会将`内核空间`中的数据拷贝到`用户空间`，**注意**这个数据拷贝阶段，应用程序是`阻塞的`，当数据拷贝完成，系统调用返回。

#### 阻塞写

前边我们在介绍`阻塞写`的时候提到`阻塞写`的风格特别的硬朗，头比较铁非要把全部发送数据一次性都写到`Socket`的发送缓冲区中才返回，如果发送缓冲区中没有足够的空间容纳，那么就一直阻塞死等，特别的刚。

相比较而言`非阻塞写`的特点就比较佛系，当发送缓冲区中没有足够的空间容纳全部发送数据时，`非阻塞写`的特点是`能写多少写多少`，写不下了，就立即返回。并将写入到发送缓冲区的字节数返回给应用程序，方便用户线程不断的`轮训`尝试将`剩下的数据`写入发送缓冲区中。

#### 非阻塞 IO 线程模型

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311435732.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031143503642" style="zoom:33%;" />

基于以上`非阻塞IO`的特点，我们就不必像`阻塞IO`那样为每个请求分配一个线程去处理连接上的读写了。

我们可以利用**一个线程或者很少的线程**，去`不断地轮询`每个`Socket`的接收缓冲区是否有数据到达，如果没有数据，`不必阻塞`线程，而是接着去`轮询`下一个`Socket`接收缓冲区，直到轮询到数据后，处理连接上的读写，或者交给业务线程池去处理，轮询线程则`继续轮询`其他的`Socket`接收缓冲区。

这样一个`非阻塞IO模型`就实现了我们在本小节开始提出的需求：**我们需要用尽可能少的线程去处理更多的连接**

#### 适用场景

虽然`非阻塞IO模型`与`阻塞IO模型`相比，减少了很大一部分的资源消耗和系统开销。

但是它仍然有很大的性能问题，因为在`非阻塞IO模型`下，需要用户线程去`不断地`发起`系统调用`去轮训`Socket`接收缓冲区，这就需要用户线程不断地从`用户态`切换到`内核态`，`内核态`切换到`用户态`。随着并发量的增大，这个上下文切换的开销也是巨大的。

所以单纯的`非阻塞IO`模型还是无法适用于高并发的场景。只能适用于`C10K`以下的场景。

### IO 多路复用

::: tip 请移步

[IO 多路复用](/netty_source_code_parsing/network_program/io_multiplexing)

:::

### 信号驱动 IO

![image-20241031144043825](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311440929.png)

大家对这个装备肯定不会陌生，当我们去一些美食城吃饭的时候，点完餐付了钱，老板会给我们一个信号器。然后我们带着这个信号器可以去找餐桌，或者干些其他的事情。当信号器亮了的时候，这时代表饭餐已经做好，我们可以去窗口取餐了。

这个典型的生活场景和我们要介绍的`信号驱动IO模型`就很像。

在`信号驱动IO模型`下，用户进程操作通过`系统调用 sigaction 函数`发起一个 IO 请求，在对应的`socket`注册一个`信号回调`，此时`不阻塞`用户进程，进程会继续工作。当内核数据就绪时，内核就为该进程生成一个 `SIGIO 信号`，通过信号回调通知进程进行相关 IO 操作。

> 这里需要注意的是：`信号驱动式 IO 模型`依然是`同步IO`，因为它虽然可以在等待数据的时候不被阻塞，也不会频繁的轮询，但是当数据就绪，内核信号通知后，用户进程依然要自己去读取数据，在`数据拷贝阶段`发生阻塞。

> 信号驱动 IO 模型 相比于前三种 IO 模型，实现了在等待数据就绪时，进程不被阻塞，主循环可以继续工作，所以`理论上`性能更佳。

但是实际上，使用`TCP协议`通信时，`信号驱动IO模型`几乎`不会被采用`。原因如下：

- 信号 IO 在大量 IO 操作时可能会因为信号队列溢出导致没法通知
- `SIGIO 信号`是一种 Unix 信号，信号没有附加信息，如果一个信号源有多种产生信号的原因，信号接收者就无法确定究竟发生了什么。而 TCP socket 生产的信号事件有七种之多，这样应用程序收到 SIGIO，根本无从区分处理。

但`信号驱动IO模型`可以用在 `UDP`通信上，因为 UDP 只有`一个数据请求事件`，这也就意味着在正常情况下 UDP 进程只要捕获 SIGIO 信号，就调用 `read 系统调用`读取到达的数据。如果出现异常，就返回一个异常错误。

---

这里插句题外话，大家觉不觉得`阻塞IO模型`在生活中的例子就像是我们在食堂排队打饭。你自己需要排队去打饭同时打饭师傅在配菜的过程中你需要等待。

![image-20241031144137789](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311441825.png)

`IO多路复用模型`就像是我们在饭店门口排队等待叫号。叫号器就好比`select,poll,epoll`可以统一管理全部顾客的`吃饭就绪`事件，客户好比是`socket`连接，谁可以去吃饭了，叫号器就通知谁。

![image-20241031144235074](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311442148.png)

### 异步 IO

以上介绍的四种`IO模型`均为`同步IO`，它们都会阻塞在第二阶段`数据拷贝阶段`。

通过在前边小节《同步与异步》中的介绍，相信大家很容易就会理解`异步IO模型`，在`异步IO模型`下，IO 操作在`数据准备阶段`和`数据拷贝阶段`均是由内核来完成，不会对应用程序造成任何阻塞。应用进程只需要在`指定的数组`中引用数据即可。

`异步 IO` 与`信号驱动 IO` 的主要区别在于：`信号驱动 IO` 由内核通知何时可以`开始一个 IO 操作`，而`异步 IO`由内核通知 `IO 操作何时已经完成`。

举个生活中的例子：`异步IO模型`就像我们去一个高档饭店里的包间吃饭，我们只需要坐在包间里面，点完餐（`类比异步IO调用`）之后，我们就什么也不需要管，该喝酒喝酒，该聊天聊天，饭餐做好后服务员（`类比内核`）会自己给我们送到包间（`类比用户空间`）来。整个过程没有任何阻塞。

`异步IO`的系统调用需要操作系统内核来支持，目前只有`Window`中的`IOCP`实现了非常成熟的`异步IO机制`。

而`Linux`系统对`异步IO机制`实现的不够成熟，且与`NIO`的性能相比提升也不明显。

> 但 Linux kernel 在 5.1 版本由 Facebook 的大神 Jens Axboe 引入了新的异步 IO 库`io_uring` 改善了原来 Linux native AIO 的一些性能问题。性能相比`Epoll`以及之前原生的`AIO`提高了不少，值得关注。

再加上`信号驱动IO模型`不适用`TCP协议`，所以目前大部分采用的还是`IO多路复用模型`。

## 总结
