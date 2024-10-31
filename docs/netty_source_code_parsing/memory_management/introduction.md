# 内存管理机制简介

本文主要是做一个承上启下的作用，向读者说明为什么要学习 第三部分【数据载体与内存管理机制】

Netty 的数据载体就是 ByteBuf，对标 Java NIO 中的 ByteBuffer，他俩主要是与 Channel 打交道，从 Channel 读取数据到 ByteBuf，或者将 ByteBuf 中的数据写入 Channel

然后内存管理机制主要就是讲解直接内存以及对象池。对象池应该大家都很熟悉了，连接数据库需要用到数据库连接池，多线程编程需要用到线程池，主打就是避免对象频繁创建而拉低性能，以及复用对象

## ByteBuf 初体验

本文不讲解 ByteBuf 的具体实现类，放到以后再说。我们先看看 ByteBuf 这个接口的类注释

### ByteBuf 接口的类注释

`ByteBuf` 是一个随机和顺序可访问的字节（八位字节）序列的抽象视图。该接口提供了对一个或多个原始字节数组（`byte[]`）和 NIO 缓冲区（`ByteBuffer`）的抽象表示。

- **创建缓冲区**

建议使用 `Unpooled` 中的辅助方法创建新的缓冲区，而不是直接调用各个实现的构造函数。

- **随机访问索引**

与普通的原始字节数组一样，`ByteBuf` 使用 [零基索引](https://en.wikipedia.org/wiki/Zero-based_numbering)。这意味着第一个字节的索引总是 `0`，最后一个字节的索引总是 `capacity() - 1`。例如，要遍历缓冲区的所有字节，可以执行以下操作，无论其内部实现如何：

```java
ByteBuf buffer = ...;
for (int i = 0; i < buffer.capacity(); i++) {
    byte b = buffer.getByte(i);
    System.out.println((char) b);
}
```

- **顺序访问索引**

`ByteBuf` 提供两个指针变量以支持顺序读写操作 - `readerIndex` 用于读操作，`writerIndex` 用于写操作。下图显示了缓冲区如何被这两个指针分成三个区域：

```java
+-------------------+------------------+------------------+
| discardable bytes |  readable bytes  |  writable bytes  |
|                   |     (CONTENT)    |                  |
+-------------------+------------------+------------------+
|                   |                  |                  |
0      <=      readerIndex   <=   writerIndex    <=    capacity
```

- **可读字节（实际内容）**

这一段是实际数据存储的地方。以 `read` 或 `skip` 开头的任何操作都将在当前的 `readerIndex` 获取或跳过数据，并将其增加读取的字节数。如果读取操作的参数也是一个 `ByteBuf`，并且没有指定目标索引，则将增加指定缓冲区的 `writerIndex`。

如果剩余内容不足，则会引发 `IndexOutOfBoundsException`。新分配、包装或复制的缓冲区的 `readerIndex` 默认值为 `0`。

```java
ByteBuf buffer = ...;
while (buffer.isReadable()) {
    System.out.println(buffer.readByte());
}
```

- **可写字节**

这一段是需要填充的未定义空间。以 `write` 开头的任何操作都将在当前的 `writerIndex` 写入数据，并将其增加写入的字节数。如果写操作的参数也是一个 `ByteBuf`，并且没有指定源索引，则将一起增加指定缓冲区的 `readerIndex`。

如果剩余可写字节不足，则会引发 `IndexOutOfBoundsException`。新分配缓冲区的 `writerIndex` 默认值为 `0`，包装或复制缓冲区的 `writerIndex` 默认值为缓冲区的 `capacity`。

```java
// 用随机整数填充缓冲区的可写字节。
ByteBuf buffer = ...;
while (buffer.maxWritableBytes() >= 4) {
    buffer.writeInt(random.nextInt());
}
```

- **可丢弃字节**

这一段包含已通过读取操作读取的字节。最初，这一段的大小为 `0`，但随着读取操作的执行，其大小会增加到 `writerIndex`。可以通过调用 `discardReadBytes()` 来丢弃读取的字节，以回收未使用的区域，如下图所示：

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

- **清除缓冲区索引**

可以通过调用 `clear()` 将 `readerIndex` 和 `writerIndex` 都设置为 `0`。这不会清除缓冲区的内容（例如，填充为 `0`），而只是清除这两个指针。请注意，此操作的语义与 `ByteBuffer#clear()` 不同。

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

- **搜索操作**

对于简单的单字节搜索，使用 `indexOf(int, int, byte)` 和 `bytesBefore(int, int, byte)`。`bytesBefore(byte)` 在处理以 `NUL` 结尾的字符串时尤其有用。对于复杂的搜索，使用 `forEachByte(int, int, ByteProcessor)` 和 `ByteProcessor` 实现。

- **标记和重置**

每个缓冲区都有两个标记索引。一个用于存储 `readerIndex`，另一个用于存储 `writerIndex`。可以通过调用重置方法随时重新定位这两个索引。它的工作方式类似于 `InputStream` 中的标记和重置方法，但没有 `readlimit`。

- **派生缓冲区**

可以通过调用以下方法之一创建现有缓冲区的视图：

- `duplicate()`
- `slice()`
- `slice(int, int)`
- `readSlice(int)`
- `retainedDuplicate()`
- `retainedSlice()`
- `retainedSlice(int, int)`
- `readRetainedSlice(int)`

派生缓冲区将拥有独立的 `readerIndex`、`writerIndex` 和标记索引，同时它共享其他内部数据表示，就像 NIO 缓冲区一样。

如果需要现有缓冲区的完整副本，请调用 `copy()` 方法。

- **非保留和保留的派生缓冲区**

请注意，`duplicate()`、`slice()`、`slice(int, int)` 和 `readSlice(int)` 不会在返回的派生缓冲区上调用 `retain()`，因此其引用计数不会增加。如果需要创建具有增加的引用计数的派生缓冲区，请考虑使用 `retainedDuplicate()`、`retainedSlice()`、`retainedSlice(int, int)` 和 `readRetainedSlice(int)`，这可能返回生成更少垃圾的缓冲区实现。

- **转换为现有 JDK 类型**
- **字节数组**

如果一个 `ByteBuf` 由字节数组（即 `byte[]`）支持，可以通过 `array()` 方法直接访问。要确定缓冲区是否由字节数组支持，应使用 `hasArray()`。

- **NIO 缓冲区**

如果一个 `ByteBuf` 可以转换为共享其内容的 NIO `ByteBuffer`（即视图缓冲区），可以通过 `nioBuffer()` 方法获取。要确定缓冲区是否可以转换为 NIO 缓冲区，请使用 `nioBufferCount()`。

- **字符串**

各种 `toString(Charset)` 方法将 `ByteBuf` 转换为 `String`。请注意，`toString()` 不是转换方法。

- **I/O 流**

请参考 `ByteBufInputStream` 和 `ByteBufOutputStream`。

---

### ByteBuf 的使用场景

然后我们其实在使用 ByteBuf 的时候都是直接去用这个接口，底层的各种具体实现固然重要，都有各自特点，它们对外提供的抽象是一致的。所以我们在不知道底层的具体实现之前，可以先了解一下这些 API 在 Netty 中是如何被使用的，也就是 ByteBuf 的使用场景

在 [Netty 如何接收网络数据](https://www.yuque.com/onejava/gwzrgm/hxu3hq49zi0eb0gu) 一文中。我们了解到在 Sub Reactor 线程读取网络读取网络数据的时候会使用到 ByteBuf

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730104994746-c64504cf-9fdb-4234-978c-0145bb710dd7.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730105206365-6e9a7efb-9507-421f-939f-6929bb13e988.png)

---

```java
@Override
protected int doReadBytes(ByteBuf byteBuf) throws Exception {
    final RecvByteBufAllocator.Handle allocHandle = unsafe().recvBufAllocHandle();
    allocHandle.attemptedBytesRead(byteBuf.writableBytes());
    return byteBuf.writeBytes(javaChannel(), allocHandle.attemptedBytesRead());
}
```

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730105405288-459b431d-6305-4919-8adf-c13e1f8d0d63.png)

上述这俩 attemptedBytesRead 主要的任务就是得到 此 byteBuf 还能读多少数据

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730105479424-2e95fbba-086d-44c3-9f55-62c004a3bdd1.png)

然后我们之前传进来的 ByteBuf 就开始从 Channel 中“读取”数据了

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730105558534-de5d73c6-30a6-4ee8-b15e-b12b8b7d99f5.png)

我们在这里以 PooledByteBuf 中的实现为例，可以看到最后也是使用了 Java NIO Channel 和 Java NIO Buffer 去读取数据（PooledByteBuf 底层就是 Java NIO Buffer）

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730105591181-30b055f0-dabf-40d6-b967-d059ee06f7b0.png)

所以 ByteBuf 是当之无愧的数据搬运工

### ByteBuf 是如何被创建的

我们以 [Netty 如何接收网络数据](https://www.yuque.com/onejava/gwzrgm/hxu3hq49zi0eb0gu) 中的关键代码为例，其实 ByteBuf 还有很多创建的时机，但是本文只讨论部分关键代码

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730106708687-ce52cae0-710b-4c1e-83ab-162718820f40.png)

allocate =》分配

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730107247003-7cdf3772-314d-4a71-b324-61e62bb5d619.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730107328213-3a29d3c0-d735-4ab3-981f-10b8fa11355a.png)

由官方注释可知

- `ByteBufAllocator`接口的实现类负责分配缓冲区。此接口的实现应该是线程安全的。
- `RecvByteBufAllocator`分配一个新的接收缓冲区，该缓冲区的容量可能足够大以读取所有入站数据，并且足够小以不浪费其空间

- - `ByteBuf allocate(ByteBufAllocator alloc);`创建一个新的接收缓冲区，其容量可能足够大以读取所有入站数据，并且足够小以不浪费其空间。

这里很有趣，说明 `RecvByteBufAllocator.Handle` 是用于控制`ByteBufAllocator`创建出来的`ByteBuf`的大小，所以其实主要的“创建权”在`ByteBufAllocator`手上，`RecvByteBufAllocator.Handle`只是来打个配合

我们再次深入到 `allocate`方法里，我们随机选择一个具体实现类进行分析

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730107628447-0dbab534-1c4c-417c-a0bb-21537cddc362.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730107640908-05d983e6-bc78-49ce-96c1-691eb4735d78.png)

可见 `RecvByteBufAllocator`是为`ByteBufAllocator.ioBuffer`提供 `initalCapacity` 参数的

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730107708522-c724ad92-21e8-46cc-95e6-c0cbe2759cfe.png)

看这个方法名我们就可以明白，`RecvByteBufAllocator`通过某些特定的算法去决定 ByteBuf 的初始容量，使其动态变化

具体如何去实现动态大小变化的在 [4、ByteBuffer 动态自适应扩缩容机制](https://www.yuque.com/onejava/gwzrgm/hxu3hq49zi0eb0gu#apeCv) 中有讲解

### ByteBuf 的多态

由 [ByteBuf 是如何被创建的](https://www.yuque.com/onejava/gwzrgm/lsszqorno1pfg5e4#fSS4e) 可知，ByteBuf 的创建通常是由`ByteBufAllocator`负责的

我们看看`ByteBufAllocator`又是咋来的

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108055786-194dbe34-3ee1-4289-b1c0-3a5f8ecf2ef5.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108106693-c8a632d8-bb6c-4198-a651-743c46bb4cca.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108116192-828d59bb-97d4-4c99-8ccc-e8697571574b.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108128710-a77172ba-55e4-4362-8a3a-f11591511d57.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108151864-ee429da0-722f-43a5-94f1-b67a3950c724.png)

好了最后终于找到了

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108174489-d6265e5c-e06d-4bf0-b0dd-de8e38627519.png)

这里主要决定了 ByteBuf 是 unpooled 还是 pooled 的，也就是 ByteBuf 的子类是池化的还是非池化的

我们再随机选择一个非池化 allocator 点进去看看

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108337214-4c7c95a4-11bb-49ae-9365-4ace6c0d018b.png)

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108405273-9ec44b1c-4b0a-439b-8a27-74048a6285fb.png)

其实由这个 DIRECT_BUFFER_PREFERRED 常量名我们就可以推断，Netty 是偏好直接内存的

最后来到了这个静态代码块

![img](https://cdn.nlark.com/yuque/0/2024/png/35210587/1730108439091-592fbc47-c41a-42ed-be91-442c4a8d2d67.png)

这段代码通过检查几个条件来设置 `DIRECT_BUFFER_PREFERRED` 的值。我们逐条解释：

1. `CLEANER != NOOP`：

- - `CLEANER` 和 `NOOP` 是两个标识或静态变量。`CLEANER` 表示可能存在的缓冲区清理器（通常用于直接缓冲区的清理，以避免内存泄漏），而 `NOOP` 则表示不执行清理操作的占位符。
  - `CLEANER != NOOP` 表示如果缓冲区清理器存在且有效（即 `CLEANER` 不等于 `NOOP`），则此条件为 `true`。

1. `SystemPropertyUtil.getBoolean("io.netty.noPreferDirect", false)`：

- - 通过调用 `SystemPropertyUtil.getBoolean` 方法从系统属性中读取 `"io.netty.noPreferDirect"`，该属性允许用户指定是否“优先选择直接缓冲区”。
  - 如果该属性存在且值为 `true`，则返回 `true`；否则返回 `false`。若属性未设置，则默认为 `false`。

1. `&& !SystemPropertyUtil.getBoolean("io.netty.noPreferDirect", false)`：

- - 表示当系统属性 `io.netty.noPreferDirect` 未设置或为 `false` 时，才会继续考虑 `CLEANER != NOOP` 的结果。

**最终逻辑：**

- `DIRECT_BUFFER_PREFERRED` 会被设为 `true`，仅当 `CLEANER` 有效且系统属性 `io.netty.noPreferDirect` 为 `false` 时。

---

好了，对 ByteBuf 的初体验到这里就结束了，在后面还会对它进行深入讲解，其实在上述内容我们就发现了，ByteBuf 有很多分类，在 [数据搬运工：ByteBuf 体系的设计与实现](https://www.yuque.com/onejava/gwzrgm/zcgbcezm9dig3n59) 一文的开始也提到了 ByteBuf 各种分类，中你可能会感到陌生的几个关键词有 ` 直接内存``池化``Unsafe``Cleaner `等等，接下来我们就来大致介绍一下这几个关键词

## Netty 的内存管理机制

### 什么是直接内存

[Java-直接内存 DirectMemory 详解-腾讯云开发者社区-腾讯云](https://cloud.tencent.com/developer/article/1586341)

### 对象池

[详解 Recycler 对象池的精妙设计与实现](https://www.yuque.com/onejava/gwzrgm/rgrioohg7r427tzy)

### 内存池
