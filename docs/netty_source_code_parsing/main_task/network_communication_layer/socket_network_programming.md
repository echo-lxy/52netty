# Socket 网络编程

## 前言

Netty 的定位是 Java 的网络通信框架，它在底层也需要用到操作系统向应用层提供的 Socket 系统调用，所以我们在[《图解 Netty 源码》](/netty_source_code_parsing/ready_to_go/introduce)主线任务的第一篇文章中先来讲解一下 Socket 网络编程

有关计算机网络分层想必大家多多少少都有一些了解，有很多种不同的分层方式，本文就选用 TCP/IP 协议分层展开讲解

TCP/IP 协议分层自顶向下包括

* **应用层**：负责与用户交互并处理特定的应用需求，如 HTTP、FTP、SMTP 等协议
* **传输层**：负责端到端的数据传输，常见的协议有 TCP 和 UDP
* **网络层**：负责在不同网络之间路由数据包，IP 协议是网络层的核心
* **链路层**：负责数据帧的传输和物理链路的管理，包括以太网等协议

如下图所示

![image-20241029221357740](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029221357740.png)



由此可推测，开发者如需开发位于应用层的 APP 则需要使用 **操作系统提供给用户的TCP或者UDP的系统调用** 进行网络相关的编程

那么这个系统调用是什么呢？我们如何去调用呢？

对，这就是 Socket

![image-20241029221645821](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029221645821.png)

原来Socket在这里

**Socket 是什么呢？**

Socket 是应用层与 TCP/IP 协议族通信的中间软件抽象层，它是一组接口。在设计模式中，Socket 其实就是一个 **门面模式**，它把复杂的 TCP/IP 协议族**隐藏**在 Socket 接口后面，对用户来说，一组简单的接口就是全部，让 Socket 去组织数据，以符合指定的协议。

**你会使用它们吗？**

前人已经给我们做了好多的事了，网络间的通信也就简单了许多，但毕竟还是有挺多工作要做的。以前听到 Socket 编程，觉得它是比较高深的编程知识，但是只要弄清 Socket 编程的工作原理，神秘的面纱也就揭开了。

一个生活中的场景。你要打电话给一个朋友，先拨号，朋友听到电话铃声后提起电话，这时你和你的朋友就建立起了连接，就可以讲话了。等交流结束，挂断电话结束此次交谈。 生活中的场景就解释了这工作原理，也许 TCP/IP 协议族就是诞生于生活中，这也说不准。

## 什么是 Socket？

**socket 一词的起源**

在计算机组网领域中，`socket` 一词首次出现在 1970 年 2 月 12 日发布的文献 **IETF RFC33** 中，撰写者为 Stephen Carr、Steve Crocker 和 Vint Cerf。根据美国计算机历史博物馆的记载，Crocker 写道：“命名空间的元素都可称为套接字接口。一个套接字接口构成一个连接的一端，而一个连接可完全由一对套接字接口规定。”

计算机历史博物馆补充道：“这比 BSD 套接字接口的定义早了大约 12 年。”

---

上面我们已经了解到网络中的进程是通过 `socket` 进行通信的。那么，什么是 **socket** 呢？

`socket` 起源于 Unix，而 Unix/Linux 的一个基本哲学是 “一切皆文件” ，都可以使用 “打开 `open` → 读写 `write/read` → 关闭 `close`” 的模式进行操作。

可以理解为，`socket` 就是这种模式的一个实现：它是一种特殊的文件，允许我们使用各种 `socket` 函数对其进行操作（例如读/写 IO、打开和关闭）。接下来，我们会基于 **C语言** 进一步介绍这些函数的具体作用。

## TCP Socket 通信基本流程

先来看一张 客户端/服务端 的 TCP 通信流程图

![网络基础——socket的通信流程介绍，基于tcp协议通信的socket程序编写 - 1024bits - 博客园](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1989606-20200813102302358-1945159613.png)

**TCP 连接建立过程**

1. **Socket 初始化**:
   - **服务端**: 创建一个 `socket` 对象，用于接收客户端连接。该对象的文件描述符用于后续的网络操作。
   - **客户端**: 创建一个 `socket` 对象，用于与服务端进行连接。

2. **服务端绑定**:
   - **bind**: 服务端通过调用 `bind()` 函数将 `socket` 绑定到特定的 IP 地址和端口号，使其能够监听来自该 IP 和端口的连接请求。

3. **监听连接**:
   - **listen**: 调用 `listen()` 函数开始监听连接请求。此时，服务端的 `socket` 进入被动等待状态，准备接受客户端的连接。

4. **等待客户端连接**:
   - **accept**: 服务端调用 `accept()` 函数，此函数会阻塞并等待客户端连接。一旦有客户端发起连接请求，`accept()` 会返回一个新的 `socket`，称为“已完成连接 socket”，该 `socket` 用于后续的数据传输。

5. **客户端发起连接**:
   - **connect**: 客户端调用 `connect()` 函数，向服务端的 IP 地址和端口发送连接请求。如果连接成功，服务端的 `accept()` 将返回一个新 `socket`。

---

**数据传输过程**

6. **读写操作**:
   - **write**: 客户端通过调用 `write()` 函数将数据发送到服务端。此时数据会通过已完成连接的 `socket` 传输。
   - **read**: 服务端调用 `read()` 函数从已完成连接的 `socket` 中读取数据。这个过程类似于文件流的读写，数据在两者之间进行流动。

7. **连接关闭**:
   - **EOF**: 当客户端关闭连接（例如调用 `close()`），服务端的 `read()` 操作会读取到 EOF（文件结束符），这表明客户端已经关闭连接。
   - **close**: 服务端在处理完所有数据后调用 `close()` 函数，关闭已完成连接的 `socket`，释放相关资源。

---

**关键点**

- **监听 Socket vs. 已完成连接 Socket**:
   - **监听 Socket**: 主要用于接收连接请求，不能用于实际的数据传输。
   - **已完成连接 Socket**: 一旦 `accept()` 返回，新的 `socket` 就会用于数据传输。

- **数据流**: 数据在 TCP 连接中以字节流的形式进行读写，这与文件操作类似，使得网络通信的处理方式变得直观。

- **阻塞与非阻塞**: 上述过程中的 `accept()` 和 `read()` 等调用可能是阻塞的，意味着调用会等待直到有连接或数据可用。



## Socket 的基本操作

既然 **Socket** 是一种“`open—write/read—close`”模式的实现，因此它提供了对应的操作函数接口。下面以 **TCP** 为例，介绍几个基本的 **Socket** 接口函数。

### socket()函数

```c
int socket(int domain, int type, int protocol);
```

`socket` 函数对应于普通文件的打开操作。普通文件的打开操作返回一个文件描述符，而 `socket()` 用于创建一个 **socket 描述符（socket descriptor）**，它唯一标识一个 **socket**。这个 **socket** 描述符与文件描述符类似，后续操作都将使用它作为参数，进行一些读写操作。

正如可以传入不同参数值给 `fopen` 以打开不同文件一样，创建 **socket** 时，也可以指定不同参数来创建不同的 **socket** 描述符。`socket` 函数的三个参数分别为：

- **domain**：即协议域，也称为协议族 (**family**)。常用的协议族包括：

  - `AF_INET`：用于 IPv4 地址。
  - `AF_INET6`：用于 IPv6 地址。
  - `AF_LOCAL`（或称 `AF_UNIX`）：用于 Unix 域 socket。
  - `AF_ROUTE`：用于路由套接字。

  协议族决定了 **socket** 的地址类型，在通信中必须使用对应的地址类型。例如，`AF_INET` 代表使用 IPv4 地址（32 位）与端口号（16 位）的组合，`AF_UNIX` 则使用绝对路径名作为地址。

- **type**：指定 **socket** 类型。常见的 **socket** 类型包括：

  - `SOCK_STREAM`：流式 **socket**。
  - `SOCK_DGRAM`：数据报 **socket**。
  - `SOCK_RAW`：原始 **socket**。
  - `SOCK_PACKET`：数据包 **socket**。
  - `SOCK_SEQPACKET`：顺序包 **socket**。

- **protocol**：指定协议，常用的协议有：

  - `IPPROTO_TCP`：TCP 协议。
  - `IPPROTO_UDP`：UDP 协议。
  - `IPPROTO_SCTP`：SCTP 协议。
  - `IPPROTO_TIPC`：TIPC 协议（此协议我将另开篇讨论）。

  注意：并不是所有 `type` 和 `protocol` 都能随意组合，例如 `SOCK_STREAM` 不可与 `IPPROTO_UDP` 组合。当 `protocol` 为 `0` 时，系统会自动选择与 `type` 对应的默认协议。

调用 **`socket`** 创建一个 **socket** 时，返回的 **socket 描述符** 仅存在于协议族（**address family, AF_XXX**）空间中，并没有具体的地址。如果想为其赋予一个地址，必须调用 `bind()` 函数。否则，当调用 `connect()` 或 `listen()` 时，系统会自动随机分配一个端口。

### bind()函数

正如上面所述，`bind()` 函数将一个地址族中的特定地址赋给 socket。例如，对于 `AF_INET` 和 `AF_INET6`，它们将 IPv4 或 IPv6 地址与端口号组合并赋给 socket。

```C
int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
```

函数的三个参数分别为：

- **sockfd**：即 socket 描述字，通过 `socket()` 函数创建，唯一标识一个 socket。`bind()` 函数就是将给这个描述字绑定一个名字。

- **addr**：一个 `const struct sockaddr *` 指针，指向要绑定给 `sockfd` 的协议地址。这个地址结构根据创建 socket 时的地址协议族的不同而不同，例如，IPv4 对应的是：

  ```c
  struct sockaddr_in {
      sa_family_t sin_family; /* address family: AF_INET */
      in_port_t sin_port;     /* port in network byte order */
      struct in_addr sin_addr; /* internet address */
  };
  
  struct in_addr {
      uint32_t s_addr; /* address in network byte order */
  };
  ```

  IPv6 对应的是：

  ```c
  struct sockaddr_in6 {
      sa_family_t sin6_family; /* AF_INET6 */
      in_port_t sin6_port;     /* port number */
      uint32_t sin6_flowinfo;  /* IPv6 flow information */
      struct in6_addr sin6_addr; /* IPv6 address */
      uint32_t sin6_scope_id;   /* Scope ID (new in 2.4) */
  };
  
  struct in6_addr {
      unsigned char s6_addr[16]; /* IPv6 address */
  };
  ```

  Unix 域对应的是：

  ```c
  #define UNIX_PATH_MAX 108
  struct sockaddr_un {
      sa_family_t sun_family; /* AF_UNIX */
      char sun_path[UNIX_PATH_MAX]; /* pathname */
  };
  ```

- **addrlen**：对应的是地址的长度。

通常，服务器在启动时都会绑定一个众所周知的地址（如 IP 地址 + 端口号），以提供服务，客户端可以通过这个地址连接服务器。而客户端则不需要指定地址，系统会自动分配一个端口号与自身的 IP 地址组合。这就是为什么通常服务器端在 `listen()` 之前会调用 `bind()`，而客户端不会调用，而是在 `connect()` 时由系统随机生成一个。

> **网络字节序与主机字节序**
>
> * **主机字节序** 是指我们平常所说的大端和小端模式：不同的 CPU 有不同的字节序类型，这些字节序指的是整数在内存中保存的顺序，称为主机序。引用标准的 Big-Endian 和 Little-Endian 的定义如下：
>   *  Little-Endian 是低位字节排放在内存的低地址端，高位字节排放在内存的高地址端。
>   *  Big-Endian 是高位字节排放在内存的低地址端，低位字节排放在内存的高地址端。
> * **网络字节序**：4 个字节的 32 bit 值以下面的次序传输：首先是 0～7 bit，其次 8～15 bit，然后 16～23 bit，最后是 24~31 bit。这种传输次序称作大端字节序。**由于 TCP/IP 首部中所有的二进制整数在网络中传输时都要求以这种次序，因此它又称作网络字节序。**字节序，顾名思义，是字节的顺序，指的是大于一个字节类型的数据在内存中的存放顺序，一个字节的数据没有顺序的问题。
>   所以，在将一个地址绑定到 socket 时，请先将主机字节序转换为网络字节序，而不要假定主机字节序与网络字节序一样使用 Big-Endian。由于这个问题曾引发过严重错误！公司项目代码中由于存在这个问题，导致了很多莫名其妙的问题，因此请务必谨记对主机字节序不要做任何假定，务必将其转化为网络字节序后再赋给 socket。

### listen()、connect()函数

作为一个服务器，在调用 `socket()`、`bind()` 之后，将调用 `listen()` 来监听这个 socket。当客户端此时调用 `connect()` 发出连接请求时，服务器端将会接收到这个请求。

```c
int listen(int sockfd, int backlog);
int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
```

`listen` 函数的第一个参数是要监听的 socket 描述字，第二个参数为相应 socket 可以排队的最大连接个数。通过 `socket()` 函数创建的 socket 默认是主动类型的，`listen` 函数将 socket 变为被动类型，等待客户端的连接请求。

`connect` 函数的第一个参数是客户端的 socket 描述字，第二个参数是服务器的 socket 地址，第三个参数是 socket 地址的长度。客户端通过调用 `connect` 函数来建立与 TCP 服务器的连接。

### accept()函数

TCP 服务器端依次调用 `socket()`、`bind()`、`listen()` 之后，就会监听指定的 socket 地址。TCP 客户端依次调用 `socket()`、`connect()` 之后，会向 TCP 服务器发送连接请求。当 TCP 服务器监听到这个请求后，将调用 `accept()` 函数来接收请求，这样连接就建立好了。之后，就可以开始进行网络 I/O 操作，这类似于普通文件的读写 I/O 操作。

```c
int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
```

`accept` 函数的参数如下

* 第一个参数为服务器的 socket 描述字
* 第二个参数为指向 `struct sockaddr *` 的指针，用于返回客户端的协议地址
* 第三个参数为协议地址的长度。如果 `accept` 成功，那么其返回值是由内核自动生成的一个全新的描述字，代表与返回客户端的 TCP 连接。

::: warning 注意

`accept` 的第一个参数为服务器的 socket 描述字，是通过服务器调用 `socket()` 函数生成的，称为监听 socket 描述字；而 `accept` 函数返回的是已连接的 socket 描述字。一个服务器通常仅创建一个监听 socket 描述字，该描述字在服务器的生命周期内一直存在。内核为每个由服务器进程接受的客户连接创建一个已连接的 socket 描述字，当服务器完成对某个客户的服务时，相应的已连接 socket 描述字就会被关闭。

:::

### read()、write()等函数

万事具备，只欠东风。至此，服务器与客户端已经建立好连接，可以调用网络 I/O 进行读写操作，实现网络中不同进程之间的通信！网络 I/O 操作主要有以下几组：

- `read()` / `write()`
- `recv()` / `send()`
- `readv()` / `writev()`
- `recvmsg()` / `sendmsg()`
- `recvfrom()` / `sendto()`

我推荐使用 `recvmsg()` / `sendmsg()` 函数，这两个函数是最通用的 I/O 函数，实际上可以将上面的其他函数替换成这两个函数。它们的声明如下：

```c
#include <unistd.h>
ssize_t read(int fd, void *buf, size_t count);
ssize_t write(int fd, const void *buf, size_t count);

#include <sys/types.h>
#include <sys/socket.h>
ssize_t send(int sockfd, const void *buf, size_t len, int flags);
ssize_t recv(int sockfd, void *buf, size_t len, int flags);
ssize_t sendto(int sockfd, const void *buf, size_t len, int flags,
                const struct sockaddr *dest_addr, socklen_t addrlen);
ssize_t recvfrom(int sockfd, void *buf, size_t len, int flags,
                  struct sockaddr *src_addr, socklen_t *addrlen);
ssize_t sendmsg(int sockfd, const struct msghdr *msg, int flags);
ssize_t recvmsg(int sockfd, struct msghdr *msg, int flags);
```

`read` 函数负责从 `fd` 中读取内容。当读取成功时，`read` 返回实际所读的字节数；如果返回的值是 0，表示已经读到文件的结束；小于 0 则表示出现了错误。如果错误为 `EINTR`，说明读取是由中断引起的；如果是 `ECONNRESET`，表示网络连接出现了问题。

`write` 函数将 `buf` 中的 `nbytes` 字节内容写入文件描述符 `fd`。成功时返回写入的字节数；失败时返回 -1，并设置 `errno` 变量。在网络程序中，当我们向套接字文件描述符写时有两种可能：1) `write` 的返回值大于 0，表示写入了部分或全部的数据；2) 返回的值小于 0，此时出现了错误。我们要根据错误类型来处理。如果错误为 `EINTR`，表示在写时出现了中断错误；如果为 `EPIPE`，表示网络连接出现了问题（对方已经关闭了连接）。

其它的 I/O 函数我就不一一介绍了，具体参见官方文档或者 baidu、Google。

### close()函数

在服务器与客户端建立连接之后，会进行一些读写操作。完成读写操作后，就需要关闭相应的 socket 描述字，这就像在操作完打开的文件后调用 `fclose` 来关闭它。

```c
#include <unistd.h>
int close(int fd);
```

关闭一个 TCP socket 的默认行为是将该 socket 标记为关闭，然后立即返回到调用进程。此时，该描述字不能再由调用进程使用，也就是说不能再作为 `read` 或 `write` 的第一个参数。

需要注意的是，`close` 操作只是使相应 socket 描述字的引用计数减 1。只有当引用计数为 0 时，才会触发 TCP 客户端向服务器发送终止连接请求。

## 再探 accept & connect

Linux内核中会维护两个队列:

- 半连接队列(SYN 队列) : 接收到一个SYN 建立连接请求，处于 SYN RCVD 状态
- 全连接队列(Accpet 队列):已完成TCP 三次握手过程，处于ESTABLISHED 状态;

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730020153397-76dca9be-8108-4abc-a332-c09d256c0fc0.png" alt="img" style="zoom: 67%;" />

---

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/1730021051626-6264cfe6-8e44-4ab5-b559-4a6384ba5d29.png" alt="img" style="zoom: 67%;" />

1. 客户端的协议栈向服务端发送了 `SYN` 包，并告知服务端当前发送序列号为 `client_isn`，此时客户端进入 `SYN_SENT` 状态。
2. 服务端的协议栈收到这个包后，向客户端发送 `ACK` 应答，确认值为 `client_isn + 1`，表示对 `SYN` 包的确认。同时，服务端还发送一个 `SYN` 包，告知客户端当前的发送序列号为 `server_isn`，此时服务端进入 `SYN_RCVD` 状态。
3. 客户端协议栈收到 `ACK` 之后，应用程序从 `connect` 调用返回，表示客户端到服务端的单向连接建立成功，客户端状态变为 `ESTABLISHED`。此时，客户端协议栈也会对服务端的 `SYN` 包进行应答，回应数据为 `server_isn + 1`。
4. 当 `ACK` 应答包到达服务端后，服务端的 TCP 连接进入 `ESTABLISHED` 状态，同时服务端协议栈使得 `accept` 阻塞调用返回，此时服务端到客户端的单向连接也成功建立。

至此，客户端与服务端两个方向的连接都已成功建立。从以上描述可以看出，客户端 `connect` 成功返回是在第二次握手时，而服务端 `accept` 成功返回是在三次握手成功之后。

## TCP 握手与挥手

### TCP 的三次握手建立连接

我们知道，TCP 建立连接需要进行“三次握手”，即交换三个数据包。大致流程如下：

1. 客户端向服务器发送一个 `SYN J`。
2. 服务器向客户端响应一个 `SYN K`，并对 `SYN J` 进行确认 `ACK J+1`。
3. 客户端再向服务器发送一个确认 `ACK K+1`。

只有这样，三次握手才算完成。那么，这个三次握手发生在 socket 的哪些函数中呢？请看下图：

![image-20241029225000896](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029225000896.png)



从图中可以看出，当客户端调用 `connect` 时，触发了连接请求，向服务器发送了 `SYN J` 包，此时 `connect` 进入阻塞状态；服务器监听到连接请求，即收到 `SYN J` 包，调用 `accept` 函数接收请求并向客户端发送 `SYN K` 和 `ACK J+1`，这时 `accept` 也进入阻塞状态；客户端收到服务器的 `SYN K` 和 `ACK J+1` 后，此时 `connect` 返回，并对 `SYN K` 进行确认；服务器收到 `ACK K+1` 时，`accept` 返回，至此三次握手完毕，连接建立。

::: info 总结

客户端的 `connect` 在三次握手的第二次返回，而服务器端的 `accept` 在三次握手的第三次返回。

:::

### TCP 的四次握手释放连接

上面介绍了 socket 中 TCP 的三次握手建立过程及其涉及的 socket 函数。现在，我们来介绍 socket 中的四次握手释放连接的过程，请看下图：

![image-20241029224950758](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029224950758.png)



图示过程如下：

1. 某个应用进程首先调用 `close` 主动关闭连接，此时 TCP 发送一个 `FIN M`。
2. 另一端接收到 `FIN M` 后，执行被动关闭，对这个 `FIN` 进行确认。它的接收也作为文件结束符传递给应用进程，因为 `FIN` 的接收意味着应用进程在相应的连接上再也接收不到额外数据。
3. 一段时间之后，接收到文件结束符的应用进程调用 `close` 关闭它的 socket。这导致它的 TCP 发送一个 `FIN N`。
4. 接收到这个 `FIN` 的源发送端 TCP 对其进行确认。

这样，每个方向上都有一个 `FIN` 和 `ACK`。

## 总结

通过Socket编程，开发者能够实现高效的网络通信。理解TCP/IP协议族的层次结构以及Socket的基本操作，是进行网络编程的基础。Socket的使用简化了网络通信的复杂性，使得开发者可以专注于应用的业务逻辑，而无需深入底层的网络细节。