# Channel 接口解析

## UDP 协议

![image-20241102183255920](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411021832112.png)

下面我们对各个接口进行分析。

### AutoCloseable&Closeable

`AutoCloseable`和`Closeable`分别是自动关闭和主动关闭接口。当资源(如句柄或文件等)需要释放时，则需要调用close方法释放资源

```Java
public interface AutoCloseable {
    void close() throws Exception;
}
 
public interface Closeable extends AutoCloseable {
    void close() throws IOException;
}
```

* **`AutoCloseable`**：这是一个自Java 7引入的接口，目的是与**try-with-resources**语句一起使用。`AutoCloseable`更为通用，允许任何需要在不再使用时释放的资源实现它。它的`close()`方法可以抛出任意类型的异常（`Exception`）。

* **`Closeable`**：这是Java 5引入的一个接口，最初是为**I/O资源**（如`InputStream`、`OutputStream`和`Reader`等）设计的。`Closeable`继承了`AutoCloseable`接口，但它的`close()`方法只能抛出**`IOException`**（受检异常），因此更适合处理I/O类的资源。

### Channel

`Channel`是通道接口，针对于I/O相关的操作，需要打开和关闭操作。

```Java
public interface Channel extends Closeable {
    boolean isOpen();
 
    void close() throws IOException;
}
```

### InterruptibleChannel

`InterruptibleChannel`是支持异步关闭和中断的通道接口。为了支持Thead的interrupt模型，当线程中断时，可以执行中断处理对象的回调，从而关闭释放Channel。

```Java
public interface InterruptibleChannel extends Channel {
    void close() throws IOException;
}
```

### SelectableChannel

`SelectableChannel`接口声明了Channel是可以被选择的，在Windows平台通过`WindowsSelectorImpl`实现，Linux通过`EPollSelectorImpl`实现。此外还有`KQueue`等实现，关于`Selector`具体细节在《NIO-Selector》一文中会介绍。

### NetworkChannel

`NetworkChannel`适用于网络传输的接口。

```Java
public interface NetworkChannel extends Channel {
    //绑定地址
    NetworkChannel bind(SocketAddress var1) throws IOException;
 
    //获取本地地址
    SocketAddress getLocalAddress() throws IOException;
 
    //设置socket选项
    <T> NetworkChannel setOption(SocketOption<T> var1, T var2) throws IOException;
    
    //获取socket选项
    <T> T getOption(SocketOption<T> var1) throws IOException;
    
    //当前通道支持的socket选项
    Set<SocketOption<?>> supportedOptions();
}
```

### MulticastChannel

`MulticastChannel`是支持[组播](https://blog.csdn.net/qq_37653144/article/details/81588484)接口。

```Java
public interface MulticastChannel extends NetworkChannel {
    void close() throws IOException;
 
    MembershipKey join(InetAddress group, NetworkInterface interf) throws IOException;
 
    MembershipKey join(InetAddress group, NetworkInterface interf, InetAddress source) throws IOException;
}
```

### SelChImpl

`SelChImpl`接口用于将底层的I/O就绪状态更新为就绪事件。

```Java
public interface SelChImpl extends Channel {
 
    FileDescriptor getFD();
    int getFDVal();
    //更新就绪事件
    public boolean translateAndUpdateReadyOps(int ops, SelectionKeyImpl sk);
    //设置就绪事件
    public boolean translateAndSetReadyOps(int ops, SelectionKeyImpl sk);
    //将底层的轮询操作转换为事件
    void translateAndSetInterestOps(int ops, SelectionKeyImpl sk);
    //返回channle支持的操作，比如读操作、写操作等
    int validOps();
    void kill() throws IOException;
}
```

### ReadableByteChannel&WritableByteChannel

由于UDP支持读写数据，因此还实现了`ReadableByteChannel`和`WritableByteChannel`接口

```Java
public interface ReadableByteChannel extends Channel {
    int read(ByteBuffer dst) throws IOException;
}   
 
public interface WritableByteChannel extends Channel {
    int write(ByteBuffer src) throws IOException;
}
```

### ByteChannel

`ByteChannel`是支持读写的通道。

```Java
public interface ByteChannel extends ReadableByteChannel, WritableByteChannel {
}
```

### ScatteringByteChannel&GatheringByteChannel

`ScatteringByteChannel`则支持根据传入偏移量读,支持根据传入偏移量写`GatheringByteChannel`

```Java
public interface ScatteringByteChannel extends ReadableByteChannel {
    long read(ByteBuffer[] dsts, int offset, int length) throws IOException;
    long read(ByteBuffer[] dsts) throws IOException;}
 
public interface GatheringByteChannel extends WritableByteChannel {
    long write(ByteBuffer[] srcs, int offset, int length) throws IOException;
    long write(ByteBuffer[] srcs) throws IOException;
}
```

## TCP 协议

### 客户端

![20191209111550.png](https://img2018.cnblogs.com/blog/580757/201912/580757-20191209111549572-524670716.png)

TCP协议除了不支持组播，其他和UDP是一样的,不再重复介绍。

### 服务端

![20191209112800.png](https://img2018.cnblogs.com/blog/580757/201912/580757-20191209112759695-2135321136.png)

服务端无需数据读写，仅需要接收连接，数据读写是SocketChannel干的事。因此没有`ReadableByteChannel`、`WriteableByteChannel`等读写接口

### 文件

![20191209112005.png](https://img2018.cnblogs.com/blog/580757/201912/580757-20191209112004483-1940710084.png)

文件比网络协议少了`NetworkChannel`、`SelChImpl`和`SelectableChannel`。`SelChImpl`和`SelectableChannel`主要是用于支持选择器的，由于网络传输大多数连接时空闲的，而且数据何时会到来并不知晓，同时需要支持高并发来连接，因此支持多路复用技术可以显著的提高性能，而磁盘读写则没有该需求，因此无需选择器。

`SeekableByteChannel`可以通过修改position支持从指定位置读写数据。

```Java
public interface SeekableByteChannel extends ByteChannel {
    int read(ByteBuffer dst) throws IOException;
 
    int write(ByteBuffer src) throws IOException;
    
    long position() throws IOException;
    //设置偏移量
    SeekableByteChannel position(long newPosition) throws IOException;
 
    long size() throws IOException;
    //截取指定大小
    SeekableByteChannel truncate(long size) throws IOException;
}
```

