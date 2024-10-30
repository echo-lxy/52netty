# Socket 网络编程

## 引子

有关计算机网络分层想必大家多多少少都有一些了解，本文就以 TCP/IP 协议族体系结构 作为开始

TCP/IP 协议族 自顶向下包括

* 应用层
* 传输层
* 网络层
* 链路层

如下图所示

![image-20241029221357740](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029221357740.png)



由上图可见，开发者在进行网路编程 是使用 **操作系统提供给用户的TCP或者UDP的系统调用** 来进行一系列网络通信操作

那么这个系统调用是什么呢？我们如何去调用呢？对这就是 Socket

![image-20241029221645821](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029221645821.png)

原来Socket在这里。

**Socket 是什么呢？**

Socket是应用层与TCP/IP协议族通信的中间软件抽象层，它是一组接口。在设计模式中，Socket其实就是一个 **门面模式**，它把复杂的TCP/IP协议族**隐藏**在 Socket 接口后面，对用户来说，一组简单的接口就是全部，让 Socket去组织数据，以符合指定的协议。

**你会使用它们吗？**

前人已经给我们做了好多的事了，网络间的通信也就简单了许多，但毕竟还是有挺多工作要做的。以前听到Socket编程，觉得它是比较高深的编程知识，但是只要弄清Socket编程的工作原理，神秘的面纱也就揭开了。

一个生活中的场景。你要打电话给一个朋友，先拨号，朋友听到电话铃声后提起电话，这时你和你的朋友就建立起了连接，就可以讲话了。等交流结束，挂断电话结束此次交谈。 生活中的场景就解释了这工作原理，也许TCP/IP协议族就是诞生于生活中，这也不一定。

### 什么是 Socket？

上面我们已经知道网络中的进程是通过socket来通信的，那什么是socket呢？socket起源于Unix，而Unix/Linux基本哲学之一就是“一切皆文件”，都可以用“打开open –> 读写write/read –> 关闭close”模式来操作。我的理解就是Socket就是该模式的一个实现，socket即是一种特殊的文件，一些socket函数就是对其进行的操作（读/写IO、打开、关闭），这些函数我们在后面进行介绍。

**socket 一词的起源**

在组网领域的首次使用是在1970年2月12日发布的文献IETF RFC33中发现的，撰写者为Stephen Carr、Steve Crocker和Vint Cerf。根据美国计算机历史博物馆的记载，Croker写道：“命名空间的元素都可称为套接字接口。一个套接字接口构成一个连接的一端，而一个连接可完全由一对套接字接口规定。”计算机历史博物馆补充道：“这比BSD的套接字接口定义早了大约12年。”

## TCP Socket 通信基本流程

先来看一张 客户端/服务端 的 TCP 通信流程图

![网络基础——socket的通信流程介绍，基于tcp协议通信的socket程序编写 - 1024bits - 博客园](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1989606-20200813102302358-1945159613.png)

**TCP 连接建立过程**

1. **Socket 初始化**:

- - **服务端**: 创建一个 socket 对象，用于接收客户端连接。该对象的文件描述符用于后续的网络操作。
  - **客户端**: 创建一个 socket 对象，用于与服务端进行连接。

2. **服务端绑定**:

- - **bind**: 服务端通过调用 `bind()` 函数将 socket 绑定到特定的 IP 地址和端口号，使其能够监听来自该 IP 和端口的连接请求。3**监听连接**:

- - **listen**: 调用 `listen()` 函数开始监听连接请求。此时，服务端的 socket 进入被动等待状态，准备接受客户端的连接。

3. **等待客户端连接**:

- - **accept**: 服务端调用 `accept()` 函数，此函数会阻塞并等待客户端连接。一旦有客户端发起连接请求，`accept()` 会返回一个新的 socket，称为“已完成连接 socket”，该 socket 用于后续的数据传输。

4. **客户端发起连接**:

- - **connect**: 客户端调用 `connect()` 函数，向服务端的 IP 地址和端口发送连接请求。如果连接成功，服务端的 `accept()` 将返回一个新 socket。

**数据传输过程**

5. **读写操作**:

- - **write**: 客户端通过调用 `write()` 函数将数据发送到服务端。此时数据会通过已完成连接的 socket 传输。
  - **read**: 服务端调用 `read()` 函数从已完成连接的 socket 中读取数据。这个过程类似于文件流的读写，数据在两者之间进行流动。

6. **连接关闭**:

- - **EOF**: 当客户端关闭连接（例如调用 `close()`），服务端的 `read()` 操作会读取到 EOF（文件结束符），这表明客户端已经关闭连接。
  - **close**: 服务端在处理完所有数据后调用 `close()` 函数，关闭已完成连接的 socket，释放相关资源。

**关键点**

- **监听 Socket vs. 已完成连接 Socket**:

- - **监听 Socket**: 主要用于接收连接请求，不能用于实际的数据传输。
  - **已完成连接 Socket**: 一旦 `accept()` 返回，新的 socket 就会用于数据传输。

- **数据流**: 数据在 TCP 连接中以字节流的形式进行读写，这与文件操作类似，使得网络通信的处理方式变得直观。
- **阻塞与非阻塞**: 上述过程中的 `accept()` 和 `read()` 等调用可能是阻塞的，意味着调用会等待直到有连接或数据可用。



## socket 的基本操作

既然socket是“open—write/read—close”模式的一种实现，那么socket就提供了这些操作对应的函数接口。下面以TCP为例，介绍几个基本的socket接口函数。

### socket()函数

```text
int socket(int domain, int type, int protocol);
```

socket函数对应于普通文件的打开操作。普通文件的打开操作返回一个文件描述字，而**socket()**用于创建一个socket描述符（socket descriptor），它唯一标识一个socket。这个socket描述字跟文件描述字一样，后续的操作都有用到它，把它作为参数，通过它来进行一些读写操作。

正如可以给fopen的传入不同参数值，以打开不同的文件。创建socket的时候，也可以指定不同的参数创建不同的socket描述符，socket函数的三个参数分别为：

- domain：即协议域，又称为协议族（family）。常用的协议族有，AF_INET、AF_INET6、AF_LOCAL（或称AF_UNIX，Unix域socket）、AF_ROUTE等等。协议族决定了socket的地址类型，在通信中必须采用对应的地址，如AF_INET决定了要用ipv4地址（32位的）与端口号（16位的）的组合、AF_UNIX决定了要用一个绝对路径名作为地址。
- type：指定socket类型。常用的socket类型有，SOCK_STREAM、SOCK_DGRAM、SOCK_RAW、SOCK_PACKET、SOCK_SEQPACKET等等（socket的类型有哪些？）。
- protocol：故名思意，就是指定协议。常用的协议有，IPPROTO_TCP、IPPTOTO_UDP、IPPROTO_SCTP、IPPROTO_TIPC等，它们分别对应TCP传输协议、UDP传输协议、STCP传输协议、TIPC传输协议（这个协议我将会单独开篇讨论！）。

注意：并不是上面的type和protocol可以随意组合的，如SOCK_STREAM不可以跟IPPROTO_UDP组合。当protocol为0时，会自动选择type类型对应的默认协议。

当我们调用**socket**创建一个socket时，返回的socket描述字它存在于协议族（address family，AF_XXX）空间中，但没有一个具体的地址。如果想要给它赋值一个地址，就必须调用bind()函数，否则就当调用connect()、listen()时系统会自动随机分配一个端口。

### bind()函数

正如上面所说bind()函数把一个地址族中的特定地址赋给socket。例如对应AF_INET、AF_INET6就是把一个ipv4或ipv6地址和端口号组合赋给socket。

```text
int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
```

函数的三个参数分别为：

- sockfd：即socket描述字，它是通过socket()函数创建了，唯一标识一个socket。bind()函数就是将给这个描述字绑定一个名字。
- addr：一个const struct sockaddr *指针，指向要绑定给sockfd的协议地址。这个地址结构根据地址创建socket时的地址协议族的不同而不同，如ipv4对应的是：
  struct sockaddr_in { sa_family_t sin_family; /* address family: AF_INET */ in_port_t sin_port; /* port in network byte order */ struct in_addr sin_addr; /* internet address */ }; /* Internet address. */ struct in_addr { uint32_t s_addr; /* address in network byte order */ };ipv6对应的是：
  struct sockaddr_in6 { sa_family_t sin6_family; /* AF_INET6 */ in_port_t sin6_port; /* port number */ uint32_t sin6_flowinfo; /* IPv6 flow information */ struct in6_addr sin6_addr; /* IPv6 address */ uint32_t sin6_scope_id; /* Scope ID (new in 2.4) */ }; struct in6_addr { unsigned char s6_addr[16]; /* IPv6 address */ };Unix域对应的是：
  \#define UNIX_PATH_MAX 108 struct sockaddr_un { sa_family_t sun_family; /* AF_UNIX */ char sun_path[UNIX_PATH_MAX]; /* pathname */ };
- addrlen：对应的是地址的长度。

通常服务器在启动的时候都会绑定一个众所周知的地址（如ip地址+端口号），用于提供服务，客户就可以通过它来接连服务器；而客户端就不用指定，有系统自动分配一个端口号和自身的ip地址组合。这就是为什么通常服务器端在listen之前会调用bind()，而客户端就不会调用，而是在connect()时由系统随机生成一个。

> 网络字节序与主机字节序
> **主机字节序**就是我们平常说的大端和小端模式：不同的CPU有不同的字节序类型，这些字节序是指整数在内存中保存的顺序，这个叫做主机序。引用标准的Big-Endian和Little-Endian的定义如下：
> 　　a) Little-Endian就是低位字节排放在内存的低地址端，高位字节排放在内存的高地址端。
> 　　b) Big-Endian就是高位字节排放在内存的低地址端，低位字节排放在内存的高地址端。
> **网络字节序**：4个字节的32 bit值以下面的次序传输：首先是0～7bit，其次8～15bit，然后16～23bit，最后是24~31bit。这种传输次序称作大端字节序。**由于TCP/IP首部中所有的二进制整数在网络中传输时都要求以这种次序，因此它又称作网络字节序。**字节序，顾名思义字节的顺序，就是大于一个字节类型的数据在内存中的存放顺序，一个字节的数据没有顺序的问题了。
> 所以：在将一个地址绑定到socket的时候，请先将主机字节序转换成为网络字节序，而不要假定主机字节序跟网络字节序一样使用的是Big-Endian。由于这个问题曾引发过血案！公司项目代码中由于存在这个问题，导致了很多莫名其妙的问题，所以请谨记对主机字节序不要做任何假定，务必将其转化为网络字节序再赋给socket。

### listen()、connect()函数

如果作为一个服务器，在调用socket()、bind()之后就会调用listen()来监听这个socket，如果客户端这时调用connect()发出连接请求，服务器端就会接收到这个请求。

```text
int listen(int sockfd, int backlog);int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
```

listen函数的第一个参数即为要监听的socket描述字，第二个参数为相应socket可以排队的最大连接个数。socket()函数创建的socket默认是一个主动类型的，listen函数将socket变为被动类型的，等待客户的连接请求。

connect函数的第一个参数即为客户端的socket描述字，第二参数为服务器的socket地址，第三个参数为socket地址的长度。客户端通过调用connect函数来建立与TCP服务器的连接。

### accept()函数

TCP服务器端依次调用socket()、bind()、listen()之后，就会监听指定的socket地址了。TCP客户端依次调用socket()、connect()之后就想TCP服务器发送了一个连接请求。TCP服务器监听到这个请求之后，就会调用accept()函数取接收请求，这样连接就建立好了。之后就可以开始网络I/O操作了，即类同于普通文件的读写I/O操作。

```text
int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
```

accept函数的第一个参数为服务器的socket描述字，第二个参数为指向struct sockaddr *的指针，用于返回客户端的协议地址，第三个参数为协议地址的长度。如果accpet成功，那么其返回值是由内核自动生成的一个全新的描述字，代表与返回客户的TCP连接。

注意：accept的第一个参数为服务器的socket描述字，是服务器开始调用socket()函数生成的，称为监听socket描述字；而accept函数返回的是已连接的socket描述字。一个服务器通常通常仅仅只创建一个监听socket描述字，它在该服务器的生命周期内一直存在。内核为每个由服务器进程接受的客户连接创建了一个已连接socket描述字，当服务器完成了对某个客户的服务，相应的已连接socket描述字就被关闭。

### read()、write()等函数

万事具备只欠东风，至此服务器与客户已经建立好连接了。可以调用网络I/O进行读写操作了，即实现了网咯中不同进程之间的通信！网络I/O操作有下面几组：

- read()/write()
- recv()/send()
- readv()/writev()
- recvmsg()/sendmsg()
- recvfrom()/sendto()

我推荐使用recvmsg()/sendmsg()函数，这两个函数是最通用的I/O函数，实际上可以把上面的其它函数都替换成这两个函数。它们的声明如下：

```text
#include <unistd.h>       ssize_t read(int fd, void *buf, size_t count);       ssize_t write(int fd, const void *buf, size_t count);       #include <sys/types.h>       #include <sys/socket.h>       ssize_t send(int sockfd, const void *buf, size_t len, int flags);       ssize_t recv(int sockfd, void *buf, size_t len, int flags);       ssize_t sendto(int sockfd, const void *buf, size_t len, int flags,                      const struct sockaddr *dest_addr, socklen_t addrlen);       ssize_t recvfrom(int sockfd, void *buf, size_t len, int flags,                        struct sockaddr *src_addr, socklen_t *addrlen);       ssize_t sendmsg(int sockfd, const struct msghdr *msg, int flags);       ssize_t recvmsg(int sockfd, struct msghdr *msg, int flags);
```

read函数是负责从fd中读取内容.当读成功时，read返回实际所读的字节数，如果返回的值是0表示已经读到文件的结束了，小于0表示出现了错误。如果错误为EINTR说明读是由中断引起的，如果是ECONNREST表示网络连接出了问题。

write函数将buf中的nbytes字节内容写入文件描述符fd.成功时返回写的字节数。失败时返回-1，并设置errno变量。 在网络程序中，当我们向套接字文件描述符写时有俩种可能。1)write的返回值大于0，表示写了部分或者是全部的数据。2)返回的值小于0，此时出现了错误。我们要根据错误类型来处理。如果错误为EINTR表示在写的时候出现了中断错误。如果为EPIPE表示网络连接出现了问题(对方已经关闭了连接)。

其它的我就不一一介绍这几对I/O函数了，具体参见man文档或者baidu、Google，下面的例子中将使用到send/recv。

### close()函数

在服务器与客户端建立连接之后，会进行一些读写操作，完成了读写操作就要关闭相应的socket描述字，好比操作完打开的文件要调用fclose关闭打开的文件。

```text
#include <unistd.h>int close(int fd);
```

close一个TCP socket的缺省行为时把该socket标记为以关闭，然后立即返回到调用进程。该描述字不能再由调用进程使用，也就是说不能再作为read或write的第一个参数。

注意：close操作只是使相应socket描述字的引用计数-1，只有当引用计数为0的时候，才会触发TCP客户端向服务器发送终止连接请求。

### accept&connect

Linux内核中会维护两个队列:

- 半连接队列(SYN 队列) : 接收到一个SYN 建立连接请求，处于 SYN RCVD 状态
- 全连接队列(Accpet 队列):已完成TCP 三次握手过程，处于ESTABLISHED 状态;

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730020153397-76dca9be-8108-4abc-a332-c09d256c0fc0.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730021051626-6264cfe6-8e44-4ab5-b559-4a6384ba5d29.png)

1. 客户端的协议栈向服务端发送了 SYN 包，并告诉服务端当前发送序列号 client isn，客户端进入 SYN SENT 状态。
2. 服务端的协议栈收到这个包之后，和客户端进行 ACK 应答，应答的值为 client_isn+1，表示对 SYN 包 client isn 的确认，同时服务端也发送一个 SYN 包，告诉客户端当前我的发送序列号为 server_isn，服务端进入 SYN_RCVD 状态。
3. 客户端协议栈收到 ACK 之后，使得应用程序从 connect 调用返回，表示客户端到服务端的单向连接建立成功，客户端的状态为 ESTABLISHED，同时客户端协议栈也会对服务端的 SYN 包进行应答，应答数据为 server isn+1。
4. ACK 应答包到达服务端后，服务端的 TCP 连接进入 ESTABLISHED 状态，同时服务端协议栈使得 accept 阻塞调用返回，这个时候服务端到客户端的单向连接也建立成功。

至此，客户端与服务端两个方向的连接都建立成功。从上面的描述过程，我们可以得知客户端 connect 成功返回是在第二次握手，服务端 accept 成功返回是在三次握手成功之后。

## 握手与挥手

### socket中TCP的三次握手建立连接详解

我们知道tcp建立连接要进行“三次握手”，即交换三个分组。大致流程如下：

- 客户端向服务器发送一个SYN J
- 服务器向客户端响应一个SYN K，并对SYN J进行确认ACK J+1
- 客户端再想服务器发一个确认ACK K+1

只有就完了三次握手，但是这个三次握手发生在socket的那几个函数中呢？请看下图：

![image-20241029225000896](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029225000896.png)



图1、socket中发送的TCP三次握手

从图中可以看出，当客户端调用connect时，触发了连接请求，向服务器发送了SYN J包，这时connect进入阻塞状态；服务器监听到连接请求，即收到SYN J包，调用accept函数接收请求向客户端发送SYN K ，ACK J+1，这时accept进入阻塞状态；客户端收到服务器的SYN K ，ACK J+1之后，这时connect返回，并对SYN K进行确认；服务器收到ACK K+1时，accept返回，至此三次握手完毕，连接建立。

> 总结：客户端的connect在三次握手的第二个次返回，而服务器端的accept在三次握手的第三次返回。

### socket中TCP的四次握手释放连接详解

上面介绍了socket中TCP的三次握手建立过程，及其涉及的socket函数。现在我们介绍socket中的四次握手释放连接的过程，请看下图：

![image-20241029224950758](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029224950758.png)



图2、socket中发送的TCP四次握手

图示过程如下：

- 某个应用进程首先调用close主动关闭连接，这时TCP发送一个FIN M；
- 另一端接收到FIN M之后，执行被动关闭，对这个FIN进行确认。它的接收也作为文件结束符传递给应用进程，因为FIN的接收意味着应用进程在相应的连接上再也接收不到额外数据；
- 一段时间之后，接收到文件结束符的应用进程调用close关闭它的socket。这导致它的TCP也发送一个FIN N；
- 接收到这个FIN的源发送端TCP对它进行确认。

这样每个方向上都有一个FIN和ACK。