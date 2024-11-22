# Netty 内存管理概述

::: info 提示

本文主要是做一个承上启下的作用，向读者说明为什么要学习第四部分【内存管理机制】，以及这部分的教学内容安排

:::

## 前言

Netty 的易用性和高性能使其成为流行的通信框架，尤其在高 IO 性能要求的场景中表现出色。

Netty 的底层通过使用 **Direct Memory**（直接内存），减少了内核态与用户态之间的内存拷贝，从而加速了 IO 操作的速率。然而，频繁地向系统申请 Direct Memory 并在使用后释放，依然会对性能造成一定影响。因此，Netty 内部实现了一套高效的内存管理机制。

具体来说，在申请内存时，Netty 会一次性向操作系统申请较大的一块内存，而不是每次都申请小块内存。然后，Netty 会对这块大内存进行管理，并按需将其拆分成较小的内存块进行分配。释放内存时，Netty 并不会立即将其返回操作系统，而是将内存进行回收并保留，以备下次使用。

这种内存管理机制不仅适用于 Direct Memory，也能有效管理 Heap Memory（堆内存）。

---

在这里，我想强调的是，**ByteBuf** 和 **内存** 是两个不同的概念，需要区分理解。

- **ByteBuf** 是一个对象，它需要分配内存才能正常工作。
- **内存** 可以简单地理解为操作系统的内存。虽然申请的内存也需要依赖某种存储载体：对于堆内存来说，它是通过 `byte[]` 存储；而对于 Direct 内存，则是通过 NIO 的 `ByteBuffer` 存储（因此，Java 使用 Direct Memory 的能力是由 JDK 中的 NIO 包提供的）。

之所以要强调这两个概念，是因为 **Netty 的内存池**（或称内存管理机制）处理的是内存的分配和回收，而 **ByteBuf 的回收** 是通过另一种技术——**对象池**（由 `Recycler` 实现）来完成的。

虽然这两者通常一起使用，但它们是独立的两套机制。举个例子，可能在某次创建 `ByteBuf` 时，`ByteBuf` 是通过回收机制复用的，但它所使用的内存却是新向操作系统申请的。或者，创建 `ByteBuf` 时，`ByteBuf` 是新创建的，而内存却是从回收池中获取的。

对于一次 `ByteBuf` 创建的过程，可以分成以下三个步骤：

1. 获取 `ByteBuf` 实例（可能是新创建，也可能是从缓存中获取的）。
2. 向 Netty 的内存管理机制申请内存（可能是新向操作系统申请，也可能是之前回收的内存）。
3. 将申请到的内存分配给 `ByteBuf` 使用。

接下来我来简述一下 Netty 内存管理的几个核心逻辑。

## ByteBuf 初体验

本文不讲解 ByteBuf 的具体实现类，放到以后再说。我们先看看 ByteBuf 这个接口的类注释

### 解读 ByteBuf 接口的类注释

`ByteBuf` 是一个随机和顺序可访问的字节（八位字节）序列的抽象视图。该接口提供了对一个或多个原始字节数组（`byte[]`）和 NIO 缓冲区（`ByteBuffer`）的抽象表示。

- **创建缓冲区**：建议使用 `Unpooled` 中的辅助方法创建新的缓冲区，而不是直接调用各个实现的构造函数。

- **随机访问索引**：与普通的原始字节数组一样，`ByteBuf` 使用 [零基索引](https://en.wikipedia.org/wiki/Zero-based_numbering)。这意味着第一个字节的索引总是 `0`，最后一个字节的索引总是 `capacity() - 1`。例如，要遍历缓冲区的所有字节，可以执行以下操作，无论其内部实现如何：

```java
ByteBuf buffer = ...;
for (int i = 0; i < buffer.capacity(); i++) {
    byte b = buffer.getByte(i);
    System.out.println((char) b);
}
```

- **顺序访问索引**：`ByteBuf` 提供两个指针变量以支持顺序读写操作 - `readerIndex` 用于读操作，`writerIndex` 用于写操作。下图显示了缓冲区如何被这两个指针分成三个区域：

```java
+-------------------+------------------+------------------+
| discardable bytes |  readable bytes  |  writable bytes  |
|                   |     (CONTENT)    |                  |
+-------------------+------------------+------------------+
|                   |                  |                  |
0      <=      readerIndex   <=   writerIndex    <=    capacity
```

- **可读字节（实际内容）**：这一段是实际数据存储的地方。以 `read` 或 `skip` 开头的任何操作都将在当前的 `readerIndex` 获取或跳过数据，并将其增加读取的字节数。如果读取操作的参数也是一个 `ByteBuf`，并且没有指定目标索引，则将增加指定缓冲区的 `writerIndex`。如果剩余内容不足，则会引发 `IndexOutOfBoundsException`。新分配、包装或复制的缓冲区的 `readerIndex` 默认值为 `0`。

```java
ByteBuf buffer = ...;
while (buffer.isReadable()) {
    System.out.println(buffer.readByte());
}
```

- **可写字节**：这一段是需要填充的未定义空间。以 `write` 开头的任何操作都将在当前的 `writerIndex` 写入数据，并将其增加写入的字节数。如果写操作的参数也是一个 `ByteBuf`，并且没有指定源索引，则将一起增加指定缓冲区的 `readerIndex`。                         如果剩余可写字节不足，则会引发 `IndexOutOfBoundsException`。新分配缓冲区的 `writerIndex` 默认值为 `0`，包装或复制缓冲区的 `writerIndex` 默认值为缓冲区的 `capacity`。

```java
// 用随机整数填充缓冲区的可写字节。
ByteBuf buffer = ...;
while (buffer.maxWritableBytes() >= 4) {
    buffer.writeInt(random.nextInt());
}
```

- **可丢弃字节**：这一段包含已通过读取操作读取的字节。最初，这一段的大小为 `0`，但随着读取操作的执行，其大小会增加到 `writerIndex`。可以通过调用 `discardReadBytes()` 来丢弃读取的字节，以回收未使用的区域，如下图所示：

```java
BEFORE discardReadBytes()

+-------------------+------------------+------------------+
| discardable bytes |  readable bytes  |  writable bytes  |
+-------------------+------------------+------------------+
|                   |                  |                  |
0      <=      readerIndex   <=   writerIndex    <=    capacity


AFTER discardReadBytes()

+------------------+--------------------------------------+
|  readable bytes  |    writable bytes (got more space)   |
+------------------+--------------------------------------+
|                  |                                      |
readerIndex (0) <= writerIndex (decreased)        <=        capacity
```

请注意，在调用 `discardReadBytes()` 之后，不保证可写字节的内容。大多数情况下，可写字节不会被移动，甚至可能被不同的数据填充，这取决于底层缓冲区的实现。

- **清除缓冲区索引**：可以通过调用 `clear()` 将 `readerIndex` 和 `writerIndex` 都设置为 `0`。这不会清除缓冲区的内容（例如，填充为 `0`），而只是清除这两个指针。请注意，此操作的语义与 `ByteBuffer#clear()` 不同。

```java
BEFORE clear()

+-------------------+------------------+------------------+
| discardable bytes |  readable bytes  |  writable bytes  |
+-------------------+------------------+------------------+
|                   |                  |                  |
0      <=      readerIndex   <=   writerIndex    <=    capacity


AFTER clear()

+---------------------------------------------------------+
|             writable bytes (got more space)             |
+---------------------------------------------------------+
|                                                         |
0 = readerIndex = writerIndex            <=            capacity
```

- **搜索操作**：对于简单的单字节搜索，使用 `indexOf(int, int, byte)` 和 `bytesBefore(int, int, byte)`。`bytesBefore(byte)` 在处理以 `NUL` 结尾的字符串时尤其有用。对于复杂的搜索，使用 `forEachByte(int, int, ByteProcessor)` 和 `ByteProcessor` 实现。

- **标记和重置**：每个缓冲区都有两个标记索引。一个用于存储 `readerIndex`，另一个用于存储 `writerIndex`。可以通过调用重置方法随时重新定位这两个索引。它的工作方式类似于 `InputStream` 中的标记和重置方法，但没有 `readlimit`。

- **派生缓冲区**可以通过调用特定方法创建现有缓冲区的视图

- **非保留和保留的派生缓冲区**：请注意，`duplicate()`、`slice()`、`slice(int, int)` 和 `readSlice(int)` 不会在返回的派生缓冲区上调用 `retain()`，因此其引用计数不会增加。如果需要创建具有增加的引用计数的派生缓冲区，请考虑使用 `retainedDuplicate()`、`retainedSlice()`、`retainedSlice(int, int)` 和 `readRetainedSlice(int)`，这可能返回生成更少垃圾的缓冲区实现。

- **转换为现有 JDK 类型**
- **字节数组**：如果一个 `ByteBuf` 由字节数组（即 `byte[]`）支持，可以通过 `array()` 方法直接访问。要确定缓冲区是否由字节数组支持，应使用 `hasArray()`。

- **NIO 缓冲区**：如果一个 `ByteBuf` 可以转换为共享其内容的 NIO `ByteBuffer`（即视图缓冲区），可以通过 `nioBuffer()` 方法获取。要确定缓冲区是否可以转换为 NIO 缓冲区，请使用 `nioBufferCount()`。

- **字符串**：各种 `toString(Charset)` 方法将 `ByteBuf` 转换为 `String`。请注意，`toString()` 不是转换方法。

- **I/O 流**：请参考 `ByteBufInputStream` 和 `ByteBufOutputStream`。

---

### ByteBuf 的【读】使用场景

当我们在使用 `ByteBuf` 时，通常都是直接操作其接口。虽然对底层的具体实现不需要过多关注，但了解这些实现的特点依然很重要，因为它们在性能优化、内存管理等方面各有不同。尽管底层的实现各不相同，但它们对外提供的抽象接口是一致的。这使得我们可以专注于 `ByteBuf` 的使用，而不必过多担心底层实现的细节。

在深入了解底层实现之前，我们可以先了解 `ByteBuf` 在 Netty 中的常见使用场景。

例如，在 [《处理 OP_READ 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_READ) 这篇文章中，我们了解到在 **Sub Reactor** 线程处理 `OP_READ` 就绪事件时，`NioByteUnsafe`类在读取数据时利用`ByteBuf` 来存储读取的数据。

```java
@Override
public final void read() {
	...
        
    final ChannelPipeline pipeline = pipeline();
    final ByteBufAllocator allocator = config.getAllocator();
    final RecvByteBufAllocator.Handle allocHandle = recvBufAllocHandle();
    allocHandle.reset(config);

    ByteBuf byteBuf = null;
    boolean close = false;
    try {
        do {
            byteBuf = allocHandle.allocate(allocator);
            allocHandle.lastBytesRead(doReadBytes(byteBuf));
            if (allocHandle.lastBytesRead() <= 0) {
                // nothing was read. release the buffer.
                byteBuf.release();
                byteBuf = null;
                close = allocHandle.lastBytesRead() < 0;
                if (close) {
                    // There is nothing left to read as we received an EOF.
                    readPending = false;
                }
                break;
            }

            allocHandle.incMessagesRead(1);
            readPending = false;
            pipeline.fireChannelRead(byteBuf);
            byteBuf = null;
        } while (allocHandle.continueReading());
		...
}
```

```java
@Override
protected int doReadBytes(ByteBuf byteBuf) throws Exception {
    final RecvByteBufAllocator.Handle allocHandle = unsafe().recvBufAllocHandle();
    allocHandle.attemptedBytesRead(byteBuf.writableBytes());
    return byteBuf.writeBytes(javaChannel(), allocHandle.attemptedBytesRead());
}
```

```java
/**
 * Set how many bytes the read operation will (or did) attempt to read.
 * @param bytes How many bytes the read operation will (or did) attempt to read.
 */
void attemptedBytesRead(int bytes);

/**
 * Get how many bytes the read operation will (or did) attempt to read.
 * @return How many bytes the read operation will (or did) attempt to read.
 */
int attemptedBytesRead();
```

上述这俩 `attemptedBytesRead` 主要的任务就是得到 此 `byteBuf` 还能读多少数据

```java
/**
 * A skeletal implementation of a buffer.
 */
public abstract class AbstractByteBuf extends ByteBuf {
    ...
    @Override
    public int writeBytes(ScatteringByteChannel in, int length) throws IOException {
        ensureWritable(length);
        int writtenBytes = setBytes(writerIndex, in, length);
        if (writtenBytes > 0) {
            writerIndex += writtenBytes;
        }
        return writtenBytes;
    }
    ...
}
```

然后我们之前传进来的 `ByteBuf` 就开始从 `Channel` 中“读取”数据了

![image-20241122220820941](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411222208031.png)

我们在这里以 PooledByteBuf 中的实现为例，可以看到最后也是使用了 Java NIO Channel 和 Java NIO Buffer 去读取数据（PooledByteBuf 底层就是 Java NIO Buffer）

```java
@Override
public final int setBytes(int index, FileChannel in, long position, int length) throws IOException {
    try {
        return in.read(internalNioBuffer(index, length), position);
    } catch (ClosedChannelException ignored) {
        return -1;
    }
}
```

综上所述，ByteBuf 是当之无愧的数据搬运工

### ByteBuf 是如何被创建的

我们以[《处理 OP_READ 事件》](/netty_source_code_parsing/main_task/event_scheduling_layer/io/OP_READ)中的关键代码为例，其实 ByteBuf 还有很多创建的时机，但是本文只讨论部分关键代码

```java
@Override
public final void read() {
	...
        
    final ChannelPipeline pipeline = pipeline();
    final ByteBufAllocator allocator = config.getAllocator();
    final RecvByteBufAllocator.Handle allocHandle = recvBufAllocHandle();
    allocHandle.reset(config);

    ByteBuf byteBuf = null;
    boolean close = false;
    try {
        do {
            byteBuf = allocHandle.allocate(allocator);
            ...
        } while (allocHandle.continueReading());
		...
}
```



![image-20241122220838957](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411222208002.png)

![image-20241122220842060](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411222208080.png)

由源码注释可知：

- `ByteBufAllocator` 接口的实现类负责分配缓冲区。此接口的实现应该是线程安全的。
- `RecvByteBufAllocator`分配一个新的接收缓冲区，该缓冲区的容量可能足够大以读取所有入站数据，并且足够小以不浪费空间。
  - `ByteBuf allocate(ByteBufAllocator alloc);` 创建一个新的接收缓冲区，其容量可能足够大以读取所有入站数据，并且足够小以不浪费空间。

这里很有趣，说明 `RecvByteBufAllocator.Handle` 是用于控制 `ByteBufAllocator` 创建出来的 `ByteBuf` 的大小。所以，实际上主要的“创建权”在 `ByteBufAllocator` 手上，`RecvByteBufAllocator.Handle` 只是起到辅助作用。

接下来，我们深入分析 `allocate` 方法，选择一个具体实现类进行详细探讨。

![image-20241122220847084](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411222208936.png)

![image-20241122220851330](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411222208616.png)

可见 `RecvByteBufAllocator`是为`ByteBufAllocator.ioBuffer`提供 `initalCapacity` 参数的

![image-20241122220858613](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411222209611.png)

看这个方法名我们就可以明白，`RecvByteBufAllocator`通过某些特定的算法去决定 ByteBuf 的初始容量，使其动态变化

具体如何去实现动态大小变化的在 [4、ByteBuffer 动态自适应扩缩容机制](https://www.yuque.com/onejava/gwzrgm/hxu3hq49zi0eb0gu#apeCv) 中有讲解

## ByteBuf 的多态

### 深入 ByteBuf 的创建

由上一小节《ByteBuf 是如何被创建的》可知，ByteBuf 的创建通常是由`ByteBufAllocator`负责的

我们看看`ByteBufAllocator`又是咋来的

![image-20241122220903666](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411222209482.png)

![image-20241122220909100](C:/Users/lxy/AppData/Roaming/Typora/typora-user-images/image-20241122220909100.png)

![image-20241122220914163](C:/Users/lxy/AppData/Roaming/Typora/typora-user-images/image-20241122220914163.png)

![image-20241122220919064](C:/Users/lxy/AppData/Roaming/Typora/typora-user-images/image-20241122220919064.png)

![image-20241122220923125](C:/Users/lxy/AppData/Roaming/Typora/typora-user-images/image-20241122220923125.png)

好了最后终于找到了

![image-20241122220928353](C:/Users/lxy/AppData/Roaming/Typora/typora-user-images/image-20241122220928353.png)

这里主要决定了 `ByteBuf` 是 **unpooled** 还是 **pooled** 的，也就是 `ByteBuf` 的子类是池化的还是非池化的。

我们再随机选择一个非池化 `allocator`，点进去看看。

![image-20241122220934232](C:/Users/lxy/AppData/Roaming/Typora/typora-user-images/image-20241122220934232.png)

![image-20241122220938140](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411222210745.png)

其实，通过 `DIRECT_BUFFER_PREFERRED` 常量名，我们可以推断出，Netty 在默认情况下是偏好使用直接内存的。

最后，来到了这个静态代码块。

![image-20241122220941651](C:/Users/lxy/AppData/Roaming/Typora/typora-user-images/image-20241122220941651.png)

这段代码通过检查几个条件来设置 `DIRECT_BUFFER_PREFERRED` 的值。我们逐条解释：

1. `CLEANER != NOOP`：
   - `CLEANER` 和 `NOOP` 是两个标识或静态变量。`CLEANER` 表示可能存在的缓冲区清理器（通常用于直接缓冲区的清理，以避免内存泄漏），而 `NOOP` 则表示不执行清理操作的占位符。
   - `CLEANER != NOOP` 表示如果缓冲区清理器存在且有效（即 `CLEANER` 不等于 `NOOP`），则此条件为 `true`。
2. `SystemPropertyUtil.getBoolean("io.netty.noPreferDirect", false)`：
   - 通过调用 `SystemPropertyUtil.getBoolean` 方法从系统属性中读取 `"io.netty.noPreferDirect"`，该属性允许用户指定是否“优先选择直接缓冲区”。
   - 如果该属性存在且值为 `true`，则返回 `true`；否则返回 `false`。若属性未设置，则默认为 `false`。
3. `&& !SystemPropertyUtil.getBoolean("io.netty.noPreferDirect", false)`：
   - 表示当系统属性 `io.netty.noPreferDirect` 未设置或为 `false` 时，才会继续考虑 `CLEANER != NOOP` 的结果。

**最终逻辑：**

- `DIRECT_BUFFER_PREFERRED` 会被设为 `true`，仅当 `CLEANER` 有效且系统属性 `io.netty.noPreferDirect` 为 `false` 时。

### 参差多态的 ByteBuf

请参阅[《ByteBuf 设计与实现》](/netty_source_code_parsing/memory_management/data_carrier/ByteBuf)

## 池化思想

| 特性         | 内存池                                | 对象池                                |
| ------------ | ------------------------------------- | ------------------------------------- |
| **用途**     | 管理内存分配，减少直接内存/堆内存分配 | 管理短生命周期对象，减少对象创建销毁  |
| **管理对象** | 内存块（例如 Chunk、Page 等）         | 任意 Java 对象                        |
| **实现机制** | 基于 jemalloc 的分级内存分配策略      | 基于 `Recycler` 和 Thread-Local Cache |
| **性能优化** | 减少内存碎片，降低 Direct Memory 开销 | 减少 GC 频率，提高对象复用率          |
| **典型用途** | `ByteBuf` 的内存分配                  | Netty 事件、任务、对象的复用          |

### 对象池

请参阅[《对象池》](/netty_source_code_parsing/memory_management/pooling_techniques/object_pool)

### 内存池

请参阅[《内存池》](/netty_source_code_parsing/memory_management/pooling_techniques/memory_pool)

## 直接内存vs堆内存



## 零拷贝
