# IO 线程模型

在[从内核角度看 IO 模型](/netty_source_code_parsing/network_program/io_model)中，我们学习了网络数据包的接收和发送过程，并通过介绍 5 种 `IO模型` 了解了内核是如何读取网络数据并通知给用户线程的。

前边的内容都是以`内核空间`的视角来剖析网络数据的收发模型，本小节我们站在`用户空间`的视角来看下如果对网络数据进行收发。

相对`内核`来讲，`用户空间的 IO 线程模型`相对就简单一些。这些`用户空间`的`IO线程模型`都是在讨论当多线程一起配合工作时谁负责接收连接，谁负责响应 IO 读写、谁负责计算、谁负责发送和接收，仅仅是用户 IO 线程的不同分工模式罢了。

开始本文之前，建议先阅读 Doug Lea 大神的[《Scalable IO in Java》](https://gee.cs.oswego.edu/dl/cpjslides/nio.pdf)

### Classic Model

![image-20241029194221068](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029194221068.png)

### Reactor

#### 单 Reactor 单线程

![image-20241029194312003](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029194312003.png)

### Reactor 多线程

![image-20241029194526982](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029194526982.png)

#### 主从 Reactor 多线程

![image-20241029194601543](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029194601543.png)

### Proactor
