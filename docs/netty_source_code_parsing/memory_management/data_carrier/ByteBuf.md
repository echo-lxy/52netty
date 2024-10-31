# 数据搬运工：ByteBuf 体系的设计与实现

尽管 ByteBuf 体系涉及到的类较多，可能让人一眼望去有些头疼，但如果从不同角度对其进行分类，整个体系的脉络会变得清晰：

**从 JVM 内存区域布局来看**，Netty 的 ByteBuf 主要分为 HeapByteBuf（堆内存）和 DirectByteBuf（堆外内存）两种类型。

**从内存管理的角度来看**，ByteBuf 分为 PooledByteBuf（池化）和 UnpooledByteBuf（非池化）两种子类型。PooledByteBuf 由内存池统一管理，减少了频繁分配和释放的开销；而 UnpooledByteBuf 则是在需要时临时创建，使用后立即释放。

**从内存访问的角度**，Netty 将 ByteBuf 分为 UnsafeByteBuf 和普通的 ByteBuf。UnsafeByteBuf 依赖 `Unsafe` 类提供的底层 API 来直接操作内存地址，而普通 ByteBuf 的内存操作则基于 NIO 中的 `ByteBuffer`，更加安全。

**从内存回收的视角**，ByteBuf 可分为带 Cleaner 的 ByteBuf 和不带 Cleaner 的 NoCleanerByteBuf。JDK 的 Cleaner 机制用于管理 NIO `ByteBuffer` 背后的 Native Memory，使内存释放由 JVM 负责；而 NoCleanerByteBuf 背后的 Native Memory 需手动释放，适合更灵活的内存管理需求。

**从内存占用统计的角度**，Netty 进一步将 ByteBuf 分为 InstrumentedByteBuf 和普通的 ByteBuf。InstrumentedByteBuf 带有内存占用的 Metrics 统计，便于监控内存使用情况，而普通 ByteBuf 则不具备此功能。

**为了实现高效的零拷贝操作**，Netty 引入了 CompositeByteBuf，用于聚合多个 ByteBuf。传统聚合方式通常需要分配一个较大的 `ByteBuf`，然后将多个 ByteBuf 的内容拷贝到新 `ByteBuf` 中。而 CompositeByteBuf 则直接提供一个逻辑上的视图，避免了额外的内存分配和拷贝开销。这里的零拷贝是 Netty 在用户态层面的设计优化，而不是操作系统级别的零拷贝。

此外，Netty 的 ByteBuf 支持引用计数和自动内存泄漏检测。如果出现内存泄漏，Netty 会提供详细的泄漏位置报告。ByteBuf 还支持自动扩容，而 JDK 的 `ByteBuffer` 则不具备此功能。

综上所述，Netty 的 ByteBuf 是对 JDK `ByteBuffer` 的拓展和完善。通过对比，可以更深刻地体会到 Netty 设计的精妙之处。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729752381876-99410203-d0a6-47cd-b515-b220e22c10f2.webp)

## 1、JDK 中的 ByteBuffer 设计有何不妥

笔者曾在 [ByteBuffer](https://www.yuque.com/onejava/gwzrgm/yeht0ma5ugguw59y)一文中完整的介绍过 JDK ByteBuffer 的整个设计体系，下面我们来简短回忆一下 ByteBuffer 的几个核心要素。

```java
public abstract class Buffer {
    private int mark = -1;
    private int position = 0;
    private int limit;
    private int capacity;
}
```

- **Capacity**：定义了整个 `Buffer` 的容量，即最多可以容纳多少个元素。`capacity` 之前的空间是 `Buffer` 的可操作区域。值得注意的是，`JDK` 中的 `ByteBuffer` 是不可扩容的，一旦创建就固定了大小。
- **Position**：用于指向 `Buffer` 中下一个可操作的元素位置，初始值为 `0`。

- - 在写模式下，`position` 指针指向下一个可写入的位置。
  - 在读模式下，`position` 指针指向下一个可读取的位置。
    `Buffer` 的读写操作共享同一个 `position` 指针，因此需要根据模式切换不断调整 `position` 位置。

- **Limit**：限定了 `Buffer` 可操作元素的上限，`position` 指针不能超过 `limit`。

由于 `ByteBuffer` 仅设计了一个 `position` 指针，读写时我们需要通过 `flip()`、`rewind()`、`compact()` 和 `clear()` 等方法在读写模式之间切换 `position`。

**实际应用场景**
在向 `ByteBuffer` 中写入数据时，`position` 指针会随着数据写入逐渐向后移动。写入完成后，如果需要读取刚写入的数据，还需通过 `flip()` 将 `position` 设置为可读位置，从而切换到读模式。这种设计使得 `ByteBuffer` 的读写操作在模式切换时更加灵活。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729752501652-051e570b-f720-4216-9362-539369a62ace.webp)

```java
public final Buffer flip() {
    limit = position;
    position = 0;
    mark = -1;
    return this;
}
```

当 `ByteBuffer` 中的数据全部读取完毕后，如果需要再次向 `ByteBuffer` 写入数据，需要通过 `clear()` 方法重置 `position`，以切换回写模式：

- `**clear()**`：将 `position` 设为 `0`，`limit` 设为 `capacity`，表示整个 `Buffer` 都可以重新写入数据。这不会清空 `Buffer` 中的数据，只是将写入指针归位，使得新的数据可以覆盖先前的内容。

这样通过 `clear()` 切换到写模式后，可以安全地继续向 `ByteBuffer` 写入数据。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729752547347-b6cde1aa-9511-4c05-8072-da28ee669281.webp)

```java
public final Buffer clear() {
    position = 0;
    limit = capacity;
    mark = -1;
    return this;
}
```

如果我们只是部分读取了 `ByteBuffer` 中的数据而未全部读取，接下来要写入数据时，为了避免未被读取的部分被新的写入操作覆盖，需要使用 `compact()` 方法来切换回写模式：

- `**compact()**`：该方法会将尚未读取的数据移到 `Buffer` 的起始位置，并更新 `position` 指针，以便可以从新的 `position` 开始写入新的数据。具体过程如下：

- - 保留未被读取的部分，移动到 `Buffer` 的前面。
  - 将 `position` 设为未读取数据的结束位置，而 `limit` 则设置为 `capacity`。

使用 `compact()` 方法，可以确保在写入新数据时，不会覆盖 `Buffer` 中尚未读取的内容，从而有效地管理 `ByteBuffer` 的读写状态。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729752583297-a3bf13da-08ba-4496-a010-5bfebc117998.webp)

```java
class HeapByteBuffer extends ByteBuffer {

    //HeapBuffer中底层负责存储数据的数组
    final byte[] hb; 

    public ByteBuffer compact() {
        System.arraycopy(hb, ix(position()), hb, ix(0), remaining());
        position(remaining());
        limit(capacity());
        discardMark();
        return this;
    }

    public final int remaining() {
        return limit - position;
    }

   final void discardMark() {                          
        mark = -1;
    }
}
```

从上述对 `ByteBuffer` 的操作场景可以看出，使用 `ByteBuffer` 时需要时刻保持清晰的意识，了解哪些部分是可读的，哪些是可写的。稍不留神就可能出错。在复杂的编解码逻辑中，频繁的读写模式切换会让人感到困惑。

除了 `ByteBuffer` 的操作相对繁琐之外，`JDK` 对于 `ByteBuffer` 没有设计池化管理机制。当需要大量使用堆外内存时，我们必须不断创建 `DirectBuffer`，而 `DirectBuffer` 在使用完后又需要进行手动回收。

`JDK` 对 `DirectBuffer` 的回收存在延迟，只有在执行一次 `Full GC` 后，这些 `DirectBuffer` 依赖的原生内存才会被 `JVM` 自动回收。因此，为了及时回收这些原生内存，我们不得不操心 `DirectBuffer` 的手动释放。

另外，`JDK` 的 `ByteBuffer` 不支持引用计数设计，因此我们无法知道一个 `DirectBuffer` 被引用了多少次以及何时被释放。这导致我们难以自动检测由 `DirectBuffer` 引起的内存泄漏问题。

`JDK` 的 `ByteBuffer` 也不支持动态按需自适应扩容。创建 `ByteBuffer` 后，其容量是固定的，而我们很难在一开始就准确评估所需的容量。分配过大的容量会造成浪费，而分配过小的容量则需要在写入时频繁检查剩余容量是否足够。如果不够，就需要手动申请一个更大的 `ByteBuffer`，并将原有 `ByteBuffer` 中的数据迁移到新的 `ByteBuffer` 中，这显得非常麻烦。

此外，在多个 `JDK` 的 `ByteBuffer` 需要合并聚合时，总是要先创建一个更大的 `ByteBuffer`，然后将原有的多个 `ByteBuffer` 中的内容拷贝到新的 `ByteBuffer` 中，这涉及内存分配和拷贝的开销。

那么，为什么不利用原有的 `ByteBuffer` 所占用的内存空间，在此基础上创建一个逻辑上的视图 `ByteBuffer` 呢？将对视图 `ByteBuffer` 的所有操作转移到原有的内存空间上，这样就能节省重新分配内存和内存拷贝的开销。

接下来，我们将探讨 `Netty` 中的 `ByteBuf` 如何解决并完善上述问题。

## 2、Netty  对于 ByteBuf 的设计与实现

在之前介绍 JDK 的 ByteBuffer 整体设计时，笔者以 HeapByteBuffer 为例将 ByteBuffer 的设计体系进行了串联。本文将以 DirectByteBuf 为例，帮助大家理解 Netty 中 ByteBuf 的设计体系。

### 2.1、ByteBuf 的基本结构

```java
public abstract class AbstractByteBuf extends ByteBuf {
    int readerIndex;
    int writerIndex;
    private int markedReaderIndex;
    private int markedWriterIndex;
    private int maxCapacity;
}

public class UnpooledDirectByteBuf extends AbstractReferenceCountedByteBuf {
    private int capacity;
}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729753265047-2f79ade7-913d-426f-897c-b1373060082f.webp)

为了避免 `JDK` 的 `ByteBuffer` 在读写模式下共用一个 `position` 指针所引起的繁琐操作，`Netty` 为 `ByteBuf` 引入了两个独立的指针：`readerIndex` 和 `writerIndex`。

- `**readerIndex**`：指向 `ByteBuf` 中第一个可读字节的位置。
- `**writerIndex**`：指向 `ByteBuf` 中第一个可写的字节的位置。

通过引入这两个独立的指针，我们在对 `Netty` 的 `ByteBuf` 进行读写操作时，无需进行繁琐的读写模式切换。这使得读写操作变得更加简单和直观。

此外，`Netty` 还引入了 `markedReaderIndex` 和 `markedWriterIndex`，用于支持 `ByteBuf` 相关的标记（mark）和重置（reset）操作。这一设计与 `JDK` 中的实现保持一致，方便用户在读写过程中对指针位置进行标记和恢复。

综上所述，这种设计不仅提高了操作的灵活性和效率，也简化了用户在使用 `ByteBuf` 时的思维负担，使得在复杂的网络编程中可以更加专注于数据的处理。

```java
@Override
public ByteBuf markReaderIndex() {
    markedReaderIndex = readerIndex;
    return this;
}

@Override
public ByteBuf resetReaderIndex() {
    readerIndex(markedReaderIndex);
    return this;
}

@Override
public ByteBuf markWriterIndex() {
    markedWriterIndex = writerIndex;
    return this;
}

@Override
public ByteBuf resetWriterIndex() {
    writerIndex(markedWriterIndex);
    return this;
}
```

 由于 `JDK` 的 `ByteBuffer` 在设计上不支持扩容机制，`Netty` 为 `ByteBuf` 额外引入了一个新的字段 `maxCapacity`。该字段用于表示 `ByteBuf` 的最大容量限制，确保在扩容时不会超过这一限制。  

```java
@Override
public int calculateNewCapacity(int minNewCapacity, int maxCapacity) {
    if (minNewCapacity > maxCapacity) {
        throw new IllegalArgumentException(String.format(
                "minNewCapacity: %d (expected: not greater than maxCapacity(%d)",
                minNewCapacity, maxCapacity));
    }
}
```

`Netty` 中的 `ByteBuf` 的 `capacity` 与 `JDK` 的 `ByteBuffer` 中的 `capacity` 含义保持一致，均用于表示 `ByteBuf` 的初始容量大小。这一容量是在创建 `UnpooledDirectByteBuf` 时传入的 `initialCapacity` 参数所指定的。  

```java
public class UnpooledDirectByteBuf extends AbstractReferenceCountedByteBuf {
      // Netty ByteBuf 底层依赖的 JDK ByteBuffer
      ByteBuffer buffer;
      // ByteBuf 初始的容量，也是真正的内存占用
      private int capacity;

      public UnpooledDirectByteBuf(ByteBufAllocator alloc, int initialCapacity, int maxCapacity) {
        // 设置最大可扩容的容量
        super(maxCapacity);
        this.alloc = alloc;
        // 按照 initialCapacity 指定的初始容量，创建 JDK ByteBuffer
        setByteBuffer(allocateDirect(initialCapacity), false);
    }

    void setByteBuffer(ByteBuffer buffer, boolean tryFree) {
        // UnpooledDirectByteBuf 底层会依赖一个 JDK 的 ByteBuffer
        // 后续对 UnpooledDirectByteBuf 的操作， Netty 全部会代理到 JDK ByteBuffer 中
        this.buffer = buffer;
        // 初始指定的 ByteBuf 容量 initialCapacity
        capacity = buffer.remaining();    
    }
}
```

因此，`Netty` 中的 `ByteBuf` 可以通过 `readerIndex`、`writerIndex`、`capacity` 和 `maxCapacity` 这四个指针分割成四个部分，具体如下：

- **[0, capacity)**：这一部分是在创建 `ByteBuf` 时分配的初始容量，真正占用内存。
- **[capacity, maxCapacity)**：这一部分表示 `ByteBuf` 可扩容的容量，但尚未分配内存。
- **[0, readerIndex)**：这一部分字节是已经被读取过的字节，属于可以丢弃的范围。
- **[readerIndex, writerIndex)**：这一部分字节表示 `ByteBuf` 中可以被读取的字节。
- **[writerIndex, capacity)**：这一部分表示 `ByteBuf` 的剩余容量，也就是可以写入的字节范围。

这四个指针之间的关系可以用以下不等式表示：

*0 ≤ readerIndex ≤ writerIndex ≤ capacity ≤ maxCapacity*

通过这种结构，`Netty` 的 `ByteBuf` 提供了清晰的内存管理界面，使得开发者能够更加高效地进行数据读写操作，避免了传统 `ByteBuffer` 中常见的复杂性和混淆。

```java
private static void checkIndexBounds(final int readerIndex, final int writerIndex, final int capacity) {
    if (readerIndex < 0 || readerIndex > writerIndex || writerIndex > capacity) {
        throw new IndexOutOfBoundsException(String.format(
                "readerIndex: %d, writerIndex: %d (expected: 0 <= readerIndex <= writerIndex <= capacity(%d))",
                readerIndex, writerIndex, capacity));
    }
}
```

 在对 `ByteBuf` 进行读取操作时，需要使用 `isReadable` 方法判断 `ByteBuf` 是否可读，并通过 `readableBytes` 方法获取 `ByteBuf` 具体还有多少字节可读。当 `readerIndex` 等于 `writerIndex` 时，`ByteBuf` 就不可读了，此时 `[0, readerIndex)` 这部分字节可以被丢弃。  

```java
@Override
public boolean isReadable() {
    return writerIndex > readerIndex;
}

@Override
public int readableBytes() {
    return writerIndex - readerIndex;
}
```

在对 `ByteBuf` 进行写入操作时，需要使用 `isWritable` 方法判断 `ByteBuf` 是否可写，并通过 `writableBytes` 方法获取 `ByteBuf` 具体还可以写多少字节。当 `writerIndex` 等于 `capacity` 时，`ByteBuf` 就不可写了。  

```java
@Override
public boolean isWritable() {
    return capacity() > writerIndex;
}

@Override
public int writableBytes() {
    return capacity() - writerIndex;
}
```

 当 `ByteBuf` 的容量已被写满，变为不可写时，如果继续对 `ByteBuf` 进行写入，就需要进行扩容。然而，扩容后的 `capacity` 最大不能超过 `maxCapacity`。  

```java
final void ensureWritable0(int minWritableBytes) {
    // minWritableBytes 表示本次要写入的字节数
    // 获取当前 writerIndex 的位置
    final int writerIndex = writerIndex();
    // 为满足本次的写入操作，预期的 ByteBuf 容量大小
    final int targetCapacity = writerIndex + minWritableBytes;
    // 如果 targetCapacity 在（capacity , maxCapacity] 之间，则进行扩容
    if (targetCapacity >= 0 & targetCapacity <= capacity()) {
        // targetCapacity 在 [0 , capacity] 之间，则无需扩容，本来就可以满足
        return;
    }
    // 扩容后的 capacity 最大不能超过 maxCapacity
    if (checkBounds && (targetCapacity < 0 || targetCapacity > maxCapacity)) {
        throw new IndexOutOfBoundsException(String.format(
                "writerIndex(%d) + minWritableBytes(%d) exceeds maxCapacity(%d): %s",
                writerIndex, minWritableBytes, maxCapacity, this));
    }

    ..... 扩容 ByteBuf ......
}
```

### 2.2、ByteBuf 的读取操作

 在了解了 `ByteBuf` 的基本结构后，我们可以进一步探讨针对 `ByteBuf` 的读写等基本操作。`Netty` 支持以多种基本类型为粒度对 `ByteBuf` 进行读写，同时也支持无符号基本类型的转换以及大小端的转换。下面以 `Byte` 和 `Int` 这两种基本类型为例说明 `ByteBuf` 的读取操作。  

`ByteBuf` 中的 `get` 方法用于从 `ByteBuf` 中读取数据，而不会改变其 `readerIndex` 的位置。这使得我们可以在不影响后续读取操作的情况下访问数据。以下是一些常用的方法：

- `**getByte(int index)**`：从 `ByteBuf` 中的指定位置 `index` 读取一个 `Byte`。此方法会返回指定位置的字节值，但不会移动 `readerIndex`。
- `**getUnsignedByte(int index)**`：从 `ByteBuf` 中的指定位置 `index` 读取一个 `Byte`，并将其转换为无符号 `Byte`。同样，此方法不会改变 `readerIndex` 的位置。

```java
public abstract class AbstractByteBuf extends ByteBuf {
    @Override
    public byte getByte(int index) {
        // 检查 index 的边界，index 不能超过 capacity（index < capacity）
        checkIndex(index);
        return _getByte(index);
    }

    @Override
    public short getUnsignedByte(int index) {
        // 将获取到的 Byte 转换为 UnsignedByte
        return (short) (getByte(index) & 0xFF);
    }   

    protected abstract byte _getByte(int index);
}
```

在 `ByteBuf` 的实现中，底层依赖于一个抽象方法 `_getByte`，该方法由 `AbstractByteBuf` 的具体子类负责实现。以 `UnpooledDirectByteBuf` 类为例，其实现方式如下：

- `**_getByte**` **方法**：在 `UnpooledDirectByteBuf` 的实现中，`_getByte` 操作被直接代理给其底层依赖的 JDK `DirectByteBuffer`。这种设计使得 `UnpooledDirectByteBuf` 能够利用 JDK 提供的高效内存操作，同时保持 `ByteBuf` 的统一接口。

这种抽象和委托的设计模式为 `ByteBuf` 的灵活性和可扩展性提供了支持。具体子类可以根据需要实现特定的读写逻辑，而无需修改公共 API，从而简化了代码的维护和扩展。通过这种方式，`Netty` 能够在不同的内存管理方案之间切换，同时提供一致的用户体验。

```java
public class UnpooledDirectByteBuf  {
    // 底层依赖 JDK 的 DirectByteBuffer
    ByteBuffer buffer;

    @Override
    protected byte _getByte(int index) {
        return buffer.get(index);
    }
}
```

而在 UnpooledUnsafeDirectByteBuf 类的实现中，则是通过 `sun.misc.Unsafe` 直接从对应的内存地址中读取。

```java
public class UnpooledUnsafeDirectByteBuf {
    // 直接操作 OS 的内存地址
    long memoryAddress;
    @Override
    protected byte _getByte(int index) {
        // 底层依赖 PlatformDependent0，直接通过内存地址读取 byte
        return UnsafeByteBufUtil.getByte(addr(index));
    }

    final long addr(int index) {
        // 获取偏移 index 对应的内存地址
        return memoryAddress + index;
    }
}

final class PlatformDependent0 {
  // sun.misc.Unsafe
  static final Unsafe UNSAFE;
  static byte getByte(long address) {
        return UNSAFE.getByte(address);
    }
}
```

Netty 另外还提供了批量读取 Bytes 的操作，比如我们可以通过 `getBytes` 方法将 ByteBuf 中的数据读取到一个字节数组 `byte[]` 中，也可以读取到另一个 ByteBuf 中。

```java
@Override
public ByteBuf getBytes(int index, byte[] dst) {
    getBytes(index, dst, 0, dst.length);
    return this;
}

public abstract ByteBuf getBytes(int index, byte[] dst, int dstIndex, int length);

@Override
public ByteBuf getBytes(int index, ByteBuf dst, int length) {
    getBytes(index, dst, dst.writerIndex(), length);
    // 调整 dst 的  writerIndex
    dst.writerIndex(dst.writerIndex() + length);
    return this;
}

// 注意这里的 getBytes 方法既不会改变原来 ByteBuf 的 readerIndex 和 writerIndex
// 也不会改变目的 ByteBuf 的 readerIndex 和 writerIndex
public abstract ByteBuf getBytes(int index, ByteBuf dst, int dstIndex, int length);
```

使用 `getBytes` 方法可以将原有 `ByteBuf` 中的数据读取到目标 `ByteBuf` 中。在这个过程中，原 `ByteBuf` 的 `readerIndex` 不会发生变化，但目标 `ByteBuf` 的 `writerIndex` 会相应调整。

- 在 `UnpooledDirectByteBuf` 类的实现中，`getBytes` 操作直接代理给底层的 JDK `DirectByteBuffer`，从而利用其高效的内存访问能力。
- 对于 `UnpooledUnsafeDirectByteBuf` 类，则通过 `UNSAFE.copyMemory` 方法直接根据内存地址进行数据拷贝，这种方法提供了更高的性能。

 `public abstract ByteBuf getBytes(int index, ByteBuf dst, int length);`

官方注释：

将此缓冲区的数据传输到指定的目标，从指定的绝对索引开始。该方法基本上与 `getBytes(int, ByteBuf, int, int)` 相同，区别在于该方法会将目标的 **writerIndex** 增加传输的字节数，而 `getBytes(int, ByteBuf, int, int)` 不会。该方法不会修改源缓冲区（即 **this**）的 **readerIndex** 或 **writerIndex**。  



另一方面，`ByteBuf` 中的 `read` 方法不仅用于读取数据，还会改变其 `readerIndex` 的位置。例如：

- `**readByte**` **方法**：首先通过 `_getByte` 从 `ByteBuf` 中读取一个字节，然后将 `readerIndex` 向后移动一位。这种设计使得 `read` 方法在执行数据读取的同时，也会自动管理 `readerIndex` 的状态，简化了用户的操作。

```java
@Override
public byte readByte() {
    checkReadableBytes0(1);
    int i = readerIndex;
    byte b = _getByte(i);
    readerIndex = i + 1;
    return b;
}
```

 同样，Netty 也提供了从 `ByteBuf` 中批量读取数据的方法 `readBytes`。我们可以通过 `readBytes` 方法将一个 `ByteBuf` 中的数据读取到另一个 `ByteBuf` 中。需要注意的是，这里 Netty 会改变原 `ByteBuf` 的 `readerIndex` 以及目标 `ByteBuf` 的 `writerIndex`。  

```java
@Override
public ByteBuf readBytes(ByteBuf dst, int length) {
    readBytes(dst, dst.writerIndex(), length);
    // 改变 dst 的 writerIndex
    dst.writerIndex(dst.writerIndex() + length);
    return this;
}
```

另外，我们还可以明确指定 `dstIndex`，以便从目标 `ByteBuf` 的某个位置开始拷贝原 `ByteBuf` 中的数据。在这种情况下，仅会改变原 `ByteBuf` 的 `readerIndex`，而不会改变目标 `ByteBuf` 的 `writerIndex`。

这种行为是合理的，因为在写入目标 `ByteBuf` 时，我们已经明确指定了 `writerIndex`（即 `dstIndex`）。因此，在写入完成后，`writerIndex` 的位置无需改变。

```java
@Override
public ByteBuf readBytes(ByteBuf dst, int dstIndex, int length) {
    checkReadableBytes(length);
    getBytes(readerIndex, dst, dstIndex, length);
    // 改变原来 ByteBuf 的 readerIndex
    readerIndex += length;
    return this;
}
```

除此之外，Netty 还支持将 ByteBuf 中的数据读取到不同的目的地，比如，读取到 JDK ByteBuffer 中，读取到 FileChannel 中，读取到 OutputStream 中，以及读取到 GatheringByteChannel 中。

```java
public abstract ByteBuf readBytes(ByteBuffer dst);
public abstract ByteBuf readBytes(OutputStream out, int length) throws IOException;
public abstract int readBytes(GatheringByteChannel out, int length) throws IOException;
public abstract int readBytes(FileChannel out, long position, int length) throws IOException;
```

Netty 除了支持以字节（Byte）为粒度对 `ByteBuf` 进行读写之外，还支持以多种基本类型对 `ByteBuf` 进行读写。以下以 `Int` 类型为例进行说明。

我们可以通过 `readInt()` 从 `ByteBuf` 中读取一个 `Int` 类型的数据，随后 `ByteBuf` 的 `readerIndex` 会向后移动 4 个位置。

```java
@Override
public int readInt() {
    checkReadableBytes0(4);
    int v = _getInt(readerIndex);
    readerIndex += 4;
    return v;
}

protected abstract int _getInt(int index);
```

同理，真正负责读取数据的方法 `_getInt` 需要由 `AbstractByteBuf` 的具体子类实现。但与 `_getByte` 不同的是，`_getInt` 需要考虑字节序的问题。由于网络协议采用的是大端字节序传输，因此 Netty 的 `ByteBuf` 默认也是大端字节序。

在 `UnpooledDirectByteBuf` 的实现中，`getInt` 操作同样是直接代理给其底层依赖的 JDK `DirectByteBuffer`。

```java
public class UnpooledDirectByteBuf  {
    @Override
    protected int _getInt(int index) {
        // 代理给其底层依赖的 JDK DirectByteBuffer
        return buffer.getInt(index);
    }
}
```

 在 `UnpooledUnsafeDirectByteBuf` 的实现中，由于是通过 `sun.misc.Unsafe` 直接对内存地址进行操作，因此需要考虑字节序转换的细节。Netty 的 `ByteBuf` 默认采用大端字节序，因此在这里可以直接将低地址的字节依次放入 `Int` 数据的高位。这样可以确保在读取数据时遵循网络协议的字节序要求。  

```java
public class UnpooledUnsafeDirectByteBuf {
    @Override
    protected int _getInt(int index) {
        return UnsafeByteBufUtil.getInt(addr(index));
    }
}

final class UnsafeByteBufUtil {
    static int getInt(long address) {    
        return PlatformDependent.getByte(address) << 24 |
               (PlatformDependent.getByte(address + 1) & 0xff) << 16 |
               (PlatformDependent.getByte(address + 2) & 0xff) <<  8 |
               PlatformDependent.getByte(address + 3)  & 0xff;
    }
}
```

同时 Netty 也支持以小端字节序来从 ByteBuf 中读取 Int 数据，这里就涉及到字节序的转换了。

```java
@Override
public int readIntLE() {
    checkReadableBytes0(4);
    int v = _getIntLE(readerIndex);
    readerIndex += 4;
    return v;
}

protected abstract int _getIntLE(int index);
```

在 UnpooledDirectByteBuf 的实现中，首先通过其依赖的 JDK DirectByteBuffer    以大端序读取一个 Int 数据，然后通过 `ByteBufUtil.swapInt` 切换成小端序返回。

```java
public class UnpooledDirectByteBuf  {
    @Override
    protected int _getIntLE(int index) {
        // 切换字节序，从大端变小端
        return ByteBufUtil.swapInt(buffer.getInt(index));
    }
}
```

在 UnpooledUnsafeDirectByteBuf 的实现中，则是直接将低地址上的字节依次放到 Int 数据的低位上就可以了。

```java
public class UnpooledUnsafeDirectByteBuf {
    @Override
    protected int _getIntLE(int index) {
        return UnsafeByteBufUtil.getIntLE(addr(index));
    }
}

final class UnsafeByteBufUtil {
    static int getIntLE(long address) {
        return PlatformDependent.getByte(address) & 0xff |
               (PlatformDependent.getByte(address + 1) & 0xff) <<  8 |
               (PlatformDependent.getByte(address + 2) & 0xff) << 16 |
               PlatformDependent.getByte(address + 3) << 24;
    }
}
```

另外 Netty 也支持从 ByteBuf 中读取基本类型的 `Unsigned 类型`。

```java
@Override
public long readUnsignedInt() {
    return readInt() & 0xFFFFFFFFL;
}

@Override
public long readUnsignedIntLE() {
    return readIntLE() & 0xFFFFFFFFL;
}
```

其他基本类型的相关读取操作实现的逻辑都是大同小异，笔者就不一一列举了。

### 2.3、discardReadBytes

随着 `readBytes` 方法的不断调用，`ByteBuf` 中的 `readerIndex` 也会不断向后移动。Netty 对 `readerIndex` 的设计具有两层语义：

1. **第一层语义**：比较明显，用于表示当前 `ByteBuf` 的读取位置。当我们调用 `readBytes` 方法时，就是从 `readerIndex` 开始读取数据。当 `readerIndex` 等于 `writerIndex` 时，`ByteBuf` 就不可读取了。
2. **第二层语义**：比较含蓄，用于表示当前 `ByteBuf` 可以被丢弃的字节数。由于 `readerIndex` 用于指示当前的读取位置，位于 `readerIndex` 之前的字节必然是已经被读取完毕的。继续保留这些已读取的字节在 `ByteBuf` 中并没有必要，反而会浪费空间。因此，腾出这些空间可以为后续写入更多数据提供便利。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729755623777-7ebb57c4-d25d-4b8d-99e3-e0278360b6b3.webp)

所以一个 ByteBuf 真正的剩余可写容量的计算方式除了上小节中介绍的 `writableBytes()` 方法返回的字节数之外还需要在加上 readerIndex。

```java
@Override
public int writableBytes() {
    return capacity() - writerIndex;
}
```

举个具体的例子，当我们准备向一个 `ByteBuf` 写入 `n` 个字节时，如果 `writableBytes()` 小于 `n`，这表示当前 `ByteBuf` 的剩余容量不足以满足本次写入的字节数。

然而，如果 `readerIndex + writableBytes() >= n`，则表示通过丢弃 `ByteBuf` 中已读取的字节，可以满足本次写入的请求。在这种情况下，我们可以使用 `discardReadBytes()` 方法将 `readerIndex` 之前的字节丢弃，这样一来，可写的字节数就可以满足本次写入的要求。

接下来，如果我们考虑 `readerIndex < writerIndex` 的情况，这表示 `ByteBuf` 中还有未读取的字节。在这种情况下，丢弃已读取的字节可以有效释放空间，提升写入效率。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729755700094-b444e582-7a82-43d0-b509-bd7ae903f06f.webp)

`ByteBuf` 目前可读取的字节范围为 `[readerIndex, writerIndex)`，位于 `readerIndex` 之前的字节均可以被丢弃。接下来，我们需要将 `[readerIndex, writerIndex)` 这段范围的字节全部拷贝到 `ByteBuf` 的最前面，以直接覆盖 `readerIndex` 之前的字节。

然后，调整 `readerIndex` 和 `writerIndex` 的位置。由于 `readerIndex` 之前的字节现在已被可读字节覆盖，因此 `readerIndex` 需要重新调整为 0，而 `writerIndex` 则向前移动 `readerIndex` 的大小。这样一来，当前 `ByteBuf` 的可写容量就多出了 `readerIndex` 的大小，从而提升了写入效率。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729755727777-37466ef3-089b-463a-8096-2c4a5c662db0.webp)

另外一种情况是 `readerIndex = writerIndex` 的情况，这种情况下表示 ByteBuf 中已经没有可读字节了。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729755752700-fd59544a-153c-421a-a138-f7c6af3b823b.webp)



既然 ByteBuf 中已经没有任何可读字节了，自然也就不需要将可读字节拷贝到 ByteBuf 的开头了，直接将 readerIndex 和 writerIndex 重新调整为 0 即可。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729755771102-6ef398c1-c100-409d-aeeb-84941621166d.webp)

```java
public abstract class AbstractByteBuf extends ByteBuf {
    @Override
    public ByteBuf discardReadBytes() {
        // readerIndex 为 0 表示没有可以丢弃的字节
        if (readerIndex == 0) {
            return this;
        }

        if (readerIndex != writerIndex) {
            // 将 [readerIndex, writerIndex) 这段字节范围移动到 ByteBuf 的开头
            // 也就是丢弃 readerIndex 之前的字节
            setBytes(0, this, readerIndex, writerIndex - readerIndex);
            // writerIndex 和 readerIndex 都向前移动 readerIndex 大小
            writerIndex -= readerIndex;
            // 重新调整 markedReaderIndex 和 markedWriterIndex 的位置
            // 都对应向前移动 readerIndex 大小。
            adjustMarkers(readerIndex);
            readerIndex = 0;
        } else {
            // readerIndex = writerIndex 表示当前 ByteBuf 已经不可读了
            // 将 readerIndex 之前的字节全部丢弃，ByteBuf 恢复到最初的状态
            // 整个 ByteBuf 的容量都可以被写入
            ensureAccessible();
            adjustMarkers(readerIndex);
            writerIndex = readerIndex = 0;
        }
        return this;
    }
}
```

如果 `ByteBuf` 存在可以被丢弃的字节（即 `readerIndex > 0`），只需调用 `discardReadBytes()` 方法，就会无条件丢弃 `readerIndex` 之前的字节。

此外，Netty 还提供了 `discardSomeReadBytes()` 方法，用于有条件地丢弃字节，丢弃的条件如下：

1. **无条件丢弃**：当 `ByteBuf` 已经不可读时，会无条件丢弃已读的字节。
2. **条件丢弃**：只有当已读的字节数超过整个 `ByteBuf` 一半的容量时，才会丢弃已读字节。否则，无条件丢弃的收益可能不高，影响性能。

通过这种方式，Netty 旨在提高内存的利用效率，确保在合适的情况下进行字节的丢弃。

```java
@Override
public ByteBuf discardSomeReadBytes() {
    if (readerIndex > 0) {
        // 当 ByteBuf 已经不可读了，则无条件丢弃已读字节
        if (readerIndex == writerIndex) {
            adjustMarkers(readerIndex);
            writerIndex = readerIndex = 0;
            return this;
        }
        // 当已读的字节数超过整个 ByteBuf 的一半容量时才会丢弃已读字节
        if (readerIndex >= capacity() >>> 1) {
            setBytes(0, this, readerIndex, writerIndex - readerIndex);
            writerIndex -= readerIndex;
            adjustMarkers(readerIndex);
            readerIndex = 0;
            return this;
        }
    }
    return this;
}
```

Netty 设计的这个丢弃字节的方法在解码场景中非常有用。由于 TCP 是一个面向流的网络协议，它只会根据滑动窗口的大小进行字节流的发送，因此在应用层接收到的数据可能是一个半包，也可能是一个粘包，反正不会是一个完整的数据包。

这就要求我们在解码时，首先判断 `ByteBuf` 中的数据是否构成一个完整的数据包。只有在数据包完整时，才会读取 `ByteBuf` 中的字节并进行解码，随后将 `readerIndex` 向后移动。如果数据不够形成一个完整的数据包，则需要将 `ByteBuf` 累积缓存，直至完整数据包到达。

在极端情况下，即使我们已经解码了很多次，但缓存的 `ByteBuf` 中仍可能存在半包，由于不断有粘包到来，这将导致 `ByteBuf` 越来越大。因为已经解码了多次，所以 `ByteBuf` 中可丢弃的字节占据了大量内存空间。如果半包情况持续存在，可能会导致 `OutOfMemory`。

因此，Netty 规定，如果在解码了 16 次之后，`ByteBuf` 中仍然存在半包的情况，将会调用 `discardSomeReadBytes()` 方法，将已经解码过的字节全部丢弃，以节省不必要的内存开销。

### 2.4、ByteBuf 的写入操作

`ByteBuf` 的写入操作与读取操作互为相反。每一个读取方法，如 `getBytes`、`readBytes`、`readInt` 等，都有对应的写入操作，如 `setBytes`、`writeBytes`、`writeInt` 等基础类型的写入方法。

与 `get` 方法类似，`set` 相关的方法也只是单纯地向 `ByteBuf` 中写入数据，并不会改变其 `writerIndex` 的位置。我们可以通过 `setByte` 方法向 `ByteBuf` 中的指定位置 `index` 写入数据 `value`。这种设计允许我们在不影响 `writerIndex` 的情况下，灵活地更新 `ByteBuf` 中的特定位置的数据。

在 Netty 中，`ByteBuf` 的写入和读取操作是互为相反的操作。每一个读取方法（如 `getBytes`、`readBytes`、`readInt` 等）都有对应的写入方法（如 `setBytes`、`writeBytes`、`writeInt` 等）。这些方法的设计使得我们可以灵活地管理数据的读写。

- **Set 方法**：与 `get` 方法类似，`set` 相关的方法如 `setByte` 只是简单地向 `ByteBuf` 中的指定位置写入数据，而不改变 `writerIndex` 的位置。例如：

```java
@Override
public ByteBuf setByte(int index, int value) {
    checkIndex(index);
    _setByte(index, value);
    return this;
}

protected abstract void _setByte(int index, int value);
```

- **具体实现**：在具体的 `ByteBuf` 子类（如 `UnpooledDirectByteBuf` 和 `UnpooledUnsafeDirectByteBuf`）中，`_setByte` 方法实现具体的写入操作：

```java
public class UnpooledDirectByteBuf {
    ByteBuffer buffer;

    @Override
    protected void _setByte(int index, int value) {
        buffer.put(index, (byte) value);
    }
}

public class UnpooledUnsafeDirectByteBuf {
    long memoryAddress;

    @Override
    protected void _setByte(int index, int value) {
        UnsafeByteBufUtil.setByte(addr(index), value);
    }

    final long addr(int index) {
        return memoryAddress + index;
    }
}
```

Netty 还提供了向 `ByteBuf` 批量写入字节的方法，例如 `setBytes` 方法可以从字节数组中写入数据：

```java
@Override
public ByteBuf setBytes(int index, byte[] src) {
    setBytes(index, src, 0, src.length);
    return this;
}

public abstract ByteBuf setBytes(int index, byte[] src, int srcIndex, int length);
```

对于 `UnpooledDirectByteBuf`，此操作会直接代理给 JDK 的 `DirectByteBuffer`，而 `UnpooledUnsafeDirectByteBuf` 则通过 `UNSAFE.copyMemory` 实现字节的拷贝。



需要注意的是，`setBytes` 方法不会改变目标 `ByteBuf` 的 `writerIndex`，但会调整源 `ByteBuf` 的 `readerIndex`。与之相对，`writeBytes` 方法会改变目标 `ByteBuf` 的 `writerIndex` 和源 `ByteBuf` 的 `readerIndex`。



在写入基本类型（如 `int`）时，Netty 默认采用大端字节序。写入 `int` 的示例：

```java
@Override
public ByteBuf writeInt(int value) {
    ensureWritable0(4);
    _setInt(writerIndex, value);
    writerIndex += 4;
    return this;
}

protected abstract void _setInt(int index, int value);
```

这里的实现会考虑字节序，例如：

```java
public class UnpooledUnsafeDirectByteBuf {
    @Override
    protected void _setInt(int index, int value) {
        UnsafeByteBufUtil.setInt(addr(index), value);
    }
}
```

`UnsafeByteBufUtil` 提供了具体的字节写入方法，根据需要可以支持大端或小端字节序：

```java
final class UnsafeByteBufUtil {
    static void setInt(long address, int value) {
        PlatformDependent.putByte(address, (byte) (value >>> 24));
        PlatformDependent.putByte(address + 1, (byte) (value >>> 16));
        PlatformDependent.putByte(address + 2, (byte) (value >>> 8));
        PlatformDependent.putByte(address + 3, (byte) value);
    }
}
```

Netty 的设计允许开发者灵活高效地管理字节流的读写，尤其是在高性能网络应用中，这种设计极大地提高了数据处理的效率。

### 2.5、ByteBuf 的扩容机制

 在每次向 `ByteBuf` 写入数据时，Netty 会调用 `ensureWritable0` 方法，以判断当前 `ByteBuf` 的剩余可写容量（`capacity - writerIndex`）是否能够满足本次写入的数据大小 `minWritableBytes`。如果剩余容量不足，则需要对 `ByteBuf` 进行扩容，但扩容后的容量不能超过 `maxCapacity` 的大小。  

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729756091979-ddf00b34-ce5c-4d91-a229-7a99be6dde3c.webp)

```java
final void ensureWritable0(int minWritableBytes) {
    final int writerIndex = writerIndex();
    // 为满足本次的写入操作，预期的 ByteBuf 容量大小
    final int targetCapacity = writerIndex + minWritableBytes;
    // 剩余容量可以满足本次写入要求，直接返回，不需要扩容
    if (targetCapacity >= 0 & targetCapacity <= capacity()) {
        return;
    }
    // 扩容后的容量不能超过 maxCapacity
    if (checkBounds && (targetCapacity < 0 || targetCapacity > maxCapacity)) {
        ensureAccessible();
        throw new IndexOutOfBoundsException(String.format(
                "writerIndex(%d) + minWritableBytes(%d) exceeds maxCapacity(%d): %s",
                writerIndex, minWritableBytes, maxCapacity, this));
    }

    // 如果 targetCapacity 在（capacity , maxCapacity] 之间，则进行扩容
    // fastWritable 表示在不涉及到 memory reallocation or data-copy 的情况下，当前 ByteBuf 可以直接写入的容量
    // 对于 UnpooledDirectBuffer 这里的 fastWritable = capacity - writerIndex
    // PooledDirectBuffer 有另外的实现，这里先暂时不需要关注
    final int fastWritable = maxFastWritableBytes();
    // 计算扩容后的容量 newCapacity
    // 对于 UnpooledDirectBuffer 来说这里直接通过 calculateNewCapacity 计算扩容后的容量。
    int newCapacity = fastWritable >= minWritableBytes ? writerIndex + fastWritable
            : alloc().calculateNewCapacity(targetCapacity, maxCapacity);

    // 根据 new capacity 对 ByteBuf 进行扩容
    capacity(newCapacity);
}
```

#### 2.5.1、newCapacity 的计算逻辑

ByteBuf 的初始默认 capacity 为 256 个字节，初始默认 maxCapacity 为 `Integer.MAX_VALUE` 也就是 2G 大小。

```java
public abstract class AbstractByteBufAllocator implements ByteBufAllocator {
    // ByteBuf 的初始默认 CAPACITY
    static final int DEFAULT_INITIAL_CAPACITY = 256;
    // ByteBuf 的初始默认 MAX_CAPACITY 
    static final int DEFAULT_MAX_CAPACITY = Integer.MAX_VALUE;

    @Override
    public ByteBuf directBuffer() {
        return directBuffer(DEFAULT_INITIAL_CAPACITY, DEFAULT_MAX_CAPACITY);
    }
}
```

为满足本次写入操作，`ByteBuf` 的最小容量要求为 `minNewCapacity`，其值在 `ensureWritable0` 方法中计算为 `targetCapacity`，计算方式如下：

```
minNewCapacity = writerIndex + minWritableBytes（本次将要写入的字节数）
```

在 `ByteBuf` 的扩容逻辑中，Netty 设置了一个重要的阈值 `CALCULATE_THRESHOLD`，其大小为 4MB，这个阈值决定了 `ByteBuf` 扩容的尺度。

```java
// 扩容的尺度
static final int CALCULATE_THRESHOLD = 1048576 * 4; // 4 MiB page
```

如果 `minNewCapacity` 恰好等于 `CALCULATE_THRESHOLD`，那么扩容后的容量 `newCapacity` 就是 4MB。

如果 `minNewCapacity` 大于 `CALCULATE_THRESHOLD`，那么 `newCapacity` 将按照 4MB 的尺度进行扩容，具体逻辑如下：

1. 首先，通过 `minNewCapacity / threshold * threshold` 计算出扩容前的基准线，后续将以此基准线为基础，按照 `CALCULATE_THRESHOLD` 的粒度进行扩容。
2. 该基准线要求是 `CALCULATE_THRESHOLD` 的最小倍数，并且必须小于等于 `minNewCapacity`。

举例来说，假设 `minNewCapacity` 为 5MB，那么扩容基准线就是 4MB。在这种情况下，扩容后的容量 `newCapacity` 为：`newCapacity = 4MB + CALCULATE_THRESHOLD = 8MB`

如果计算出的基准线超过了 `maxCapacity - 4MB`，那么 `newCapacity` 将直接扩容到 `maxCapacity`。

如果 `minNewCapacity` 小于 `CALCULATE_THRESHOLD`，则 `newCapacity` 将从 64 开始，进行循环扩容，采用双倍扩容的方式，直到 `newCapacity` 大于等于 `minNewCapacity`。

```java
int newCapacity = 64;
while (newCapacity < minNewCapacity) {
    newCapacity <<= 1;
}
```

- 如果 `minNewCapacity` 在 [0, 64] 范围内，那么扩容后的 `newCapacity` 就是 64。
- 如果 `minNewCapacity` 在 [65, 128] 范围内，那么扩容后的 `newCapacity` 就是 128。
- 如果 `minNewCapacity` 在 [129, 256] 范围内，那么扩容后的 `newCapacity` 就是 256。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729757686549-ab9b5430-0e69-45c6-94e4-38ff2fb017f1.webp)



```java
public abstract class AbstractByteBufAllocator implements ByteBufAllocator {

    @Override
    public int calculateNewCapacity(int minNewCapacity, int maxCapacity) {
        // 满足本次写入操作的最小容量 minNewCapacity 不能超过 maxCapacity
        if (minNewCapacity > maxCapacity) {
            throw new IllegalArgumentException(String.format(
                    "minNewCapacity: %d (expected: not greater than maxCapacity(%d)",
                    minNewCapacity, maxCapacity));
        }
        // 用于决定扩容的尺度
        final int threshold = CALCULATE_THRESHOLD; // 4 MiB page

        if (minNewCapacity == threshold) {
            return threshold;
        }

        // If over threshold, do not double but just increase by threshold.
        if (minNewCapacity > threshold) {
            // 计算扩容基准线。
            // 要求必须是 CALCULATE_THRESHOLD 的最小倍数，而且必须要小于等于 minNewCapacity
            int newCapacity = minNewCapacity / threshold * threshold;
            if (newCapacity > maxCapacity - threshold) {
                newCapacity = maxCapacity;
            } else {
                // 按照 threshold (4M)扩容
                newCapacity += threshold;
            }
            return newCapacity;
        }

        // Not over threshold. Double up to 4 MiB, starting from 64.
        // 按照 64 的倍数进行扩容。但 newCapacity 需要大于等于 minNewCapacity。
        int newCapacity = 64;
        while (newCapacity < minNewCapacity) {
            newCapacity <<= 1;
        }

        return Math.min(newCapacity, maxCapacity);
    }
}
```

#### 2.5.2、ByteBuf 的扩容逻辑

```java
public class UnpooledDirectByteBuf  {
    // 底层依赖 JDK 的 DirectByteBuffer
    ByteBuffer buffer;
}
```

对于 `UnpooledDirectByteBuf` 来说，其底层真正存储数据的地方依赖于 JDK 中的 `DirectByteBuffer`。扩容的逻辑非常简单，具体步骤如下：

1. 首先，根据上一小节计算出的 `newCapacity` 重新分配一个新的 JDK `DirectByteBuffer`。
2. 然后，将原来的 `DirectByteBuffer` 中的数据拷贝到新的 `DirectByteBuffer` 中。
3. 最后，释放原来的 `DirectByteBuffer`，并将新的 `DirectByteBuffer` 设置到 `UnpooledDirectByteBuf` 中。

```java
public class UnpooledDirectByteBuf  {
    void setByteBuffer(ByteBuffer buffer, boolean tryFree) {
        if (tryFree) {
            ByteBuffer oldBuffer = this.buffer;
            // 释放原来的 buffer
            freeDirect(oldBuffer);
        }
        // 重新设置新的 buffer
        this.buffer = buffer;
        capacity = buffer.remaining();
    }
}
```

下面是完整的扩容操作逻辑：

```java
public class UnpooledDirectByteBuf  {
    // 底层依赖 JDK 的 DirectByteBuffer
    ByteBuffer buffer;

    @Override
    public ByteBuf capacity(int newCapacity) {
        // newCapacity 不能超过 maxCapacity
        checkNewCapacity(newCapacity);
        int oldCapacity = capacity;
        if (newCapacity == oldCapacity) {
            return this;
        }
        // 计算扩容之后需要拷贝的字节数
        int bytesToCopy;
        if (newCapacity > oldCapacity) {
            bytesToCopy = oldCapacity;
        } else {
            ........ 缩容 .......
        }
        ByteBuffer oldBuffer = buffer;
        // 根据 newCapacity 分配一个新的 ByteBuffer（JDK）
        ByteBuffer newBuffer = allocateDirect(newCapacity);
        oldBuffer.position(0).limit(bytesToCopy);
        newBuffer.position(0).limit(bytesToCopy);
        // 将原来 oldBuffer 中的数据拷贝到 newBuffer 中
        newBuffer.put(oldBuffer).clear();
        // 释放 oldBuffer，设置 newBuffer
        // 对于 UnpooledUnsafeDirectByteBuf 来说就是将 newBuffer 的地址设置到 memoryAddress 中
        setByteBuffer(newBuffer, true);
        return this;
    }
```

#### 2.5.3、强制扩容

前面介绍的 ensureWritable 方法会检查本次写入的数据大小 minWritableBytes 是否超过 ByteBuf 的最大可写容量：`maxCapacity - writerIndex`。

```java
public ByteBuf ensureWritable(int minWritableBytes) 
```

如果超过，则会抛出 `IndexOutOfBoundsException` 异常停止扩容，Netty 提供了另外一个带有 force 参数的扩容方法，用来决定在这种情况下是否强制进行扩容。

```java
 public int ensureWritable(int minWritableBytes, boolean force) 
```

当 `minWritableBytes` 已经超过 `ByteBuf` 的最大可写容量时，处理逻辑如下：

- **如果** `**force = false**`：

- - 停止扩容，直接返回，不抛出异常。

- **如果** `**force = true**`：

- - 进行强制扩容，将 `ByteBuf` 扩容至 `maxCapacity`。但如果当前容量已经达到了 `maxCapacity`，则停止扩容。

带有 `force` 参数的 `ensureWritable` 方法不会抛出异常，而是通过返回状态码来通知调用者 `ByteBuf` 的容量情况：

1. **返回 0**：表示 `ByteBuf` 当前可写容量可以满足本次写入操作的需求，不需要扩容。
2. **返回 1**：表示本次写入的数据大小已经超过了 `ByteBuf` 的最大可写容量，但 `ByteBuf` 的容量已经达到了 `maxCapacity`，无法进行扩容。
3. **返回 3**：表示本次写入的数据大小已经超过了 `ByteBuf` 的最大可写容量，这种情况下，强制将容量扩容至 `maxCapacity`。
4. **返回 2**：表示执行正常的扩容逻辑。

返回值 0 和 2 均表示 `ByteBuf` 的容量（扩容前或扩容后）可以满足本次写入的数据大小，而返回值 1 和 3 表示 `ByteBuf` 的容量（扩容前或扩容后）都无法满足本次写入的数据大小。

```java
@Override
public int ensureWritable(int minWritableBytes, boolean force) {
    // 如果剩余容量可以满足本次写入操作，则不会扩容，直接返回
    if (minWritableBytes <= writableBytes()) {
        return 0;
    }

    final int maxCapacity = maxCapacity();
    final int writerIndex = writerIndex();
    // 如果本次写入的数据大小已经超过了 ByteBuf 的最大可写容量 maxCapacity - writerIndex
    if (minWritableBytes > maxCapacity - writerIndex) {
        // force = false ， 那么停止扩容，直接返回
        // force = true, 直接扩容到 maxCapacity，如果当前 capacity 已经等于 maxCapacity 了则停止扩容
        if (!force || capacity() == maxCapacity) {
            return 1;
        }
        // 虽然扩容之后还是无法满足写入需求，但还是强制扩容至 maxCapacity
        capacity(maxCapacity);
        return 3;
    }
    // 下面就是普通的扩容逻辑
    int fastWritable = maxFastWritableBytes();
    int newCapacity = fastWritable >= minWritableBytes ? writerIndex + fastWritable
            : alloc().calculateNewCapacity(writerIndex + minWritableBytes, maxCapacity);

    // Adjust to the new capacity.
    capacity(newCapacity);
    return 2;
}
```

#### 2.5.4、自适应动态扩容

Netty 在接收网络数据的过程中，其实一开始是很难确定出该用多大容量的 ByteBuf 去接收的，所以 Netty 在一开始会首先预估一个初始容量 `DEFAULT_INITIAL (2048)`。

```java
public class AdaptiveRecvByteBufAllocator {
    static final int DEFAULT_INITIAL = 2048;
}
```

 使用初始容量为 2048 的 `ByteBuf` 读取 socket 中的数据时，在每次读取完 socket 之后，Netty 都会评估 `ByteBuf` 的容量是否合适。如果每次都能将 `ByteBuf` 装满，说明我们预估的容量太小，socket 中还有更多的数据。因此，需要对 `ByteBuf` 进行扩容，以便在下一次读取 socket 时使用一个更大的 `ByteBuf`。  

```java
private final class HandleImpl extends MaxMessageHandle {
    @Override
    public void lastBytesRead(int bytes) {
        // bytes 为本次从 socket 中真实读取的数据大小
        // attemptedBytesRead 为 ByteBuf 可写的容量大小，初始为 2048
        if (bytes == attemptedBytesRead()) {
            // 如果本次读取 socket 中的数据将 ByteBuf 装满了
            // 那么就对 ByteBuf 进行扩容，在下一次读取的时候用更大的 ByteBuf 去读
            record(bytes);
        }
        // 记录本次从 socket 中读取的数据大小
        super.lastBytesRead(bytes);
    }
}
```

Netty 在一个读取循环（read loop）中不停地读取 socket 中的数据，直到数据被读取完毕或达到最大读取次数（16 次），然后结束读取循环。`ByteBuf` 的大小直接影响 Netty 的读取次数：`ByteBuf` 越大，Netty 读取的次数就越少；`ByteBuf` 越小，Netty 读取的次数就越多。因此，需要一种机制来将 `ByteBuf` 的容量控制在一个合理的范围内。

在每轮读取循环中，Netty 会统计总共读取了多少数据，这个值被称为 `totalBytesRead`。

```java
public abstract class MaxMessageHandle implements ExtendedHandle {
    // 用于统计在一轮 read loop 中总共接收到客户端连接上的数据大小
    private int totalBytesRead;
}
```

 在每一轮的读取循环结束后，Netty 会根据 `totalBytesRead` 来判断是否应该对 `ByteBuf` 进行扩容或缩容。这样，在下一轮读取循环开始时，Netty 就可以使用一个相对合理的容量来接收 socket 中的数据，从而尽量减少读取 socket 的次数。  

```java
private final class HandleImpl extends MaxMessageHandle {
    @Override
    public void readComplete() {
            // 是否对 ByteBuf 进行扩容或者缩容
            record(totalBytesRead());
    }
}
```

**那么在什么情况下需要对 ByteBuf 扩容，每次扩容多少 ？ 什么情况下需要对 ByteBuf 进行缩容，每次缩容多少呢** ？

这就用到了一个重要的容量索引结构 ——  SIZE_TABLE，它里边定义索引了 ByteBuf 的每一种容量大小。相当于是扩缩容的容量索引表。每次扩容多少，缩容多少全部记录在这个容量索引表中。



```java
public class AdaptiveRecvByteBufAllocator {
    // 扩容步长
    private static final int INDEX_INCREMENT = 4;
    // 缩容步长
    private static final int INDEX_DECREMENT = 1;

    // ByteBuf分配容量表（扩缩容索引表）按照表中记录的容量大小进行扩缩容
    private static final int[] SIZE_TABLE;
}
```

当索引容量`小于 512` 时，`SIZE_TABLE` 中定义的容量是从 `16` 开始按照 `16` 递增。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729758398590-855b138f-3f3e-4cb2-81f8-b6bad8ffec8f.webp)

当索引容量`大于 512` 时，SIZE_TABLE 中定义的容量是按前一个索引容量的 `2 倍`递增。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729758409809-f7db2cef-6a06-457e-b4e0-976e3b3b7c98.webp)

当前 `ByteBuf` 的初始容量为 2048，它在 `SIZE_TABLE` 中的索引为 33。在一轮读取循环结束后，Netty 会根据 `totalBytesRead` 来判断是否需要对 `ByteBuf` 进行缩容或扩容。

- **如果** `**totalBytesRead**` **在** `**SIZE_TABLE[index - INDEX_DECREMENT]**` **与** `**SIZE_TABLE[index]**` **之间**（即在 [1024, 2048] 之间），说明分配的 `ByteBuf` 容量正好，不需要缩容或扩容。例如，如果本次 `totalBytesRead = 2000`，正好处在 1024 与 2048 之间，说明 2048 的容量合适。
- **如果** `**totalBytesRead**` **小于等于** `**SIZE_TABLE[index - INDEX_DECREMENT]**`（即小于等于 1024），表示读取到的字节数比当前 `ByteBuf` 容量的下一级容量还要小，这时需要设置缩容标识 `decreaseNow = true`。在下次读取循环时，如果仍然满足缩容条件，就开始进行缩容。缩容后的容量为 `SIZE_TABLE[index - INDEX_DECREMENT]`，但不能小于 `SIZE_TABLE[minIndex]`（16）。需要注意的是，缩容需要满足两次条件才能进行，且缩容步长为 1（`INDEX_DECREMENT`），因此缩容过程比较谨慎。
- **如果** `**totalBytesRead**` **大于等于当前** `**ByteBuf**` **容量的下一层容量** `**nextReceiveBufferSize**`，说明 `ByteBuf` 的容量有点小了，需要进行扩容。扩容后的容量为 `SIZE_TABLE[index + INDEX_INCREMENT]`，但不能超过 `SIZE_TABLE[maxIndex]`（65535）。满足一次扩容条件后就进行扩容，扩容步长为 4（`INDEX_INCREMENT`），因此扩容过程比较积极。

```java
private void record(int actualReadBytes) {
    if (actualReadBytes <= SIZE_TABLE[max(0, index - INDEX_DECREMENT)]) {
        // 缩容条件触发两次之后就进行缩容
        if (decreaseNow) {
            index = max(index - INDEX_DECREMENT, minIndex);
            nextReceiveBufferSize = SIZE_TABLE[index];
            decreaseNow = false;
        } else {
            decreaseNow = true;
        }
    } else if (actualReadBytes >= nextReceiveBufferSize) {
        // 扩容条件满足一次之后就进行扩容
        index = min(index + INDEX_INCREMENT, maxIndex);
        nextReceiveBufferSize = SIZE_TABLE[index];
        decreaseNow = false;
    }
}
```

### 2.6、ByteBuf 的引用计数设计

 Netty 为 `ByteBuf` 引入了引用计数机制。在 `ByteBuf` 的整个设计体系中，所有的 `ByteBuf` 都继承自一个抽象类 `AbstractReferenceCountedByteBuf`，该类实现了接口 `ReferenceCounted`。  

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729758608422-298a7b62-7485-4138-8ddc-fc4c8541cc3a.webp)

```java
public interface ReferenceCounted {
    int refCnt();
    ReferenceCounted retain();
    ReferenceCounted retain(int increment);
    boolean release();
    boolean release(int decrement);
}
```

每个 `ByteBuf` 内部都维护一个名为 `refCnt` 的引用计数。我们可以通过 `refCnt()` 方法获取当前的引用计数。当 `ByteBuf` 在其他上下文中被引用时，需要通过 `retain()` 方法将引用计数加 1。此外，我们还可以使用 `retain(int increment)` 方法来指定 `refCnt` 增加的数量（`increment`）。

对于 `ByteBuf` 的引用，释放也是必不可少的。每当我们使用完 `ByteBuf` 时，需要手动调用 `release()` 方法将引用计数减 1。当引用计数 `refCnt` 变为 0 时，Netty 会通过 `deallocate` 方法释放 `ByteBuf` 所引用的内存资源。这时，`release()` 方法会返回 `true`；如果 `refCnt` 仍不为 0，则返回 `false`。同样，我们可以通过 `release(int decrement)` 方法来指定 `refCnt` 减少的数量（`decrement`）。

#### 2.6.1、为什么要引入引用计数

“在其他上下文中引用 `ByteBuf`” 是指 `ByteBuf` 在不同的线程或逻辑上下文中被共享和使用。例如，当线程 1 创建一个 `ByteBuf` 后，将其传递给线程 2 进行处理，线程 2 又可能将其传递给线程 3。每个线程都有自己的处理逻辑，包括对 `ByteBuf` 的处理和释放等操作。这种情况导致 `ByteBuf` 实际上在多个线程的上下文中被共享。

面对这种情况，很难在单独的线程上下文中判断一个 `ByteBuf` 是否应该被释放。例如，线程 1 准备释放 `ByteBuf`，但它可能正在被其他线程使用。因此，Netty 引入引用计数机制至关重要：每次引用 `ByteBuf` 时，都需要通过 `retain()` 方法将引用计数加 1；调用 `release()` 方法时将引用计数减 1。当引用计数为 0 时，说明没有其他上下文引用 `ByteBuf`，此时 Netty 可以安全地释放它。

与 JDK 的 `DirectByteBuffer` 依赖于 GC 机制释放其背后引用的 Native Memory 不同，Netty 更倾向于在使用完毕后及时手动释放 `DirectByteBuf`。由于 `DirectByteBuffer` 的对象实例在 JVM 堆内存中所占的空间较小，GC 的触发变得困难，导致被引用的 Native Memory 释放出现延迟，严重时可能导致 OOM（内存溢出）。此外，这也会使得对 `DirectByteBuffer` 的申请操作延迟。

为了避免这些问题，Netty 选择在每次使用完毕后手动释放 Native Memory，但如果不依赖 JVM，内存泄漏仍然可能发生，例如在使用完 `ByteBuf` 后忘记调用 `release()` 方法。因此，Netty 引入引用计数的另一个原因是为了检测内存泄漏的发生。当 `ByteBuf` 不再被引用，即没有任何强引用或软引用时，如果此时发生 GC，那么这个位于 JVM 堆中的 `ByteBuf` 实例就需要被回收。Netty 会检查该 `ByteBuf` 的引用计数是否为 0。如果不为 0，说明忘记调用 `release()`，从而判断出发生了内存泄漏。

在探测到内存泄漏后，Netty 会通过 `reportLeak()` 方法将相关信息以错误日志级别输出到日志中。

看到这里，可能有人会问：“引入一个小小的引用计数有什么难度？不就是在创建 `ByteBuf` 时将引用计数 `refCnt` 初始化为 1，每次在其他上下文引用时将 `refCnt` 加 1，释放时再将 `refCnt` 减 1，减到 0 就释放 Native Memory，太简单了吧？”

事实上，Netty 对引用计数的设计非常讲究，绝非如此简单，甚至有些复杂。其背后隐藏着对性能的深度考量以及对复杂并发问题的全面考虑，体现了在性能与线程安全问题之间的反复权衡。

#### 2.6.2、引用计数的最初设计

所以为了理清关于引用计数的整个设计脉络，我们需要将版本回退到最初的起点 —— 4.1.16.Final 版本，来看一下原始的设计。

```java
public abstract class AbstractReferenceCountedByteBuf extends AbstractByteBuf {
    // 原子更新 refCnt 的 Updater
    private static final AtomicIntegerFieldUpdater<AbstractReferenceCountedByteBuf> refCntUpdater =
            AtomicIntegerFieldUpdater.newUpdater(AbstractReferenceCountedByteBuf.class, "refCnt");
    // 引用计数，初始化为 1
    private volatile int refCnt;

    protected AbstractReferenceCountedByteBuf(int maxCapacity) {
        super(maxCapacity);
        // 引用计数初始化为 1
        refCntUpdater.set(this, 1);
    }

    // 引用计数增加 increment
    private ByteBuf retain0(int increment) {
        for (;;) {
            int refCnt = this.refCnt;
            // 每次 retain 的时候对引用计数加 1
            final int nextCnt = refCnt + increment;

            // Ensure we not resurrect (which means the refCnt was 0) and also that we encountered an overflow.
            if (nextCnt <= increment) {
                // 如果 refCnt 已经为 0 或者发生溢出，则抛异常
                throw new IllegalReferenceCountException(refCnt, increment);
            }
            // CAS 更新 refCnt
            if (refCntUpdater.compareAndSet(this, refCnt, nextCnt)) {
                break;
            }
        }
        return this;
    }

    // 引用计数减少 decrement
    private boolean release0(int decrement) {
        for (;;) {
            int refCnt = this.refCnt;
            if (refCnt < decrement) {
                // 引用的次数必须和释放的次数相等对应
                throw new IllegalReferenceCountException(refCnt, -decrement);
            }
            // 每次 release 引用计数减 1 
            // CAS 更新 refCnt
            if (refCntUpdater.compareAndSet(this, refCnt, refCnt - decrement)) {
                if (refCnt == decrement) {
                    // 如果引用计数为 0 ，则释放 Native Memory，并返回 true
                    deallocate();
                    return true;
                }
                // 引用计数不为 0 ，返回 false
                return false;
            }
        }
    }
}
```

 在 `4.1.16.Final` 之前的版本设计中，`ByteBuf` 的引用计数机制确实非常简单。创建 `ByteBuf` 时，`refCnt` 被初始化为 1。每次引用时，通过调用 `retain()` 将引用计数加 1；每次释放时，通过调用 `release()` 将引用计数减 1，这一过程是在一个 `for` 循环中通过 CAS（Compare-And-Swap）操作进行替换。当引用计数减少到 0 时，`ByteBuf` 会通过 `deallocate()` 方法释放其引用的 Native Memory。  

#### 2.6.3、引入指令级别上的优化

`4.1.16.Final` 版本的设计简洁清晰，表面上没有任何问题，但 Netty 在性能方面的追求并未止步。由于在 x86 架构下，`XADD` 指令的性能优于 `CMPXCHG` 指令，因此 `compareAndSet` 方法底层是通过 `CMPXCHG` 指令实现的，而 `getAndAdd` 方法则是基于 `XADD` 指令。

因此，在对性能极致的追求下，Netty 在 `4.1.17.Final` 版本中用 `getAndAdd` 方法替换了 `compareAndSet` 方法，以提升性能表现。

```java
public abstract class AbstractReferenceCountedByteBuf extends AbstractByteBuf {

    private volatile int refCnt;

    protected AbstractReferenceCountedByteBuf(int maxCapacity) {
        super(maxCapacity);
        // 引用计数在初始的时候还是为 1 
        refCntUpdater.set(this, 1);
    }

    private ByteBuf retain0(final int increment) {
        // 相比于 compareAndSet 的实现，这里将 for 循环去掉
        // 并且每次是先对 refCnt 增加计数 increment
        int oldRef = refCntUpdater.getAndAdd(this, increment);
        // 增加完 refCnt 计数之后才去判断异常情况
        if (oldRef <= 0 || oldRef + increment < oldRef) {
            // Ensure we don't resurrect (which means the refCnt was 0) and also that we encountered an overflow.
            // 如果原来的 refCnt 已经为 0 或者 refCnt 溢出，则对 refCnt 进行回退，并抛出异常
            refCntUpdater.getAndAdd(this, -increment);
            throw new IllegalReferenceCountException(oldRef, increment);
        }
        return this;
    }

    private boolean release0(int decrement) {
        // 先对 refCnt 减少计数 decrement
        int oldRef = refCntUpdater.getAndAdd(this, -decrement);
        // 如果 refCnt 已经为 0 则进行 Native Memory 的释放
        if (oldRef == decrement) {
            deallocate();
            return true;
        } else if (oldRef < decrement || oldRef - decrement > oldRef) {
            // 如果释放次数大于 retain 次数 或者 refCnt 出现下溢
            // 则对 refCnt 进行回退，并抛出异常
            refCntUpdater.getAndAdd(this, decrement);
            throw new IllegalReferenceCountException(oldRef, decrement);
        }
        return false;
    }
}
```

在 `4.1.16.Final` 版本的实现中，Netty 在一个 `for` 循环中，首先对 `retain` 和 `release` 的异常情况进行校验，然后通过 CAS 更新 `refCnt`。如果校验不通过，则直接抛出 `IllegalReferenceCountException`，这是一种悲观更新引用计数的策略。

而在 `4.1.17.Final` 版本中，Netty 去掉了 `for` 循环，采用了与 `compareAndSet` 的实现相反的策略。它首先通过 `getAndAdd` 更新 `refCnt`，然后再判断相关的异常情况。如果发现异常，则进行回退并抛出 `IllegalReferenceCountException`，这是一种乐观更新引用计数的策略。

例如，在 `retain` 增加引用计数时，首先将 `refCnt` 增加计数 `increment`，然后检查原始的引用计数 `oldRef` 是否为 0 或者 `refCnt` 是否发生溢出。如果是，则需要对 `refCnt` 的值进行回退，并抛出异常。

在 `release` 减少引用计数时，首先将 `refCnt` 减少计数 `decrement`，然后判断 `release` 的次数是否大于 `retain` 的次数，以防止过度释放（over-release），以及 `refCnt` 是否发生下溢。如果是，则需要对 `refCnt` 的值进行回退，并抛出异常。

#### 2.6.4、并发安全问题的引入

在 4.1.17.Final 版本的设计中，我们对引用计数的 retain 以及 release 操作都要比 4.1.16.Final 版本的性能要高，虽然现在性能是高了，但是同时引入了新的并发问题。

让我们先假设一个这样的场景，现在有一个 ByteBuf，它当前的 refCnt = 1 ，线程 1 对这个 ByteBuf 执行 `release()` 操作。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729758905305-f31750b0-7a5f-4d6c-9f28-75e358004b0a.webp)

在 4.1.17.Final 的实现中，Netty 会首先通过 getAndAdd 将 refCnt 更新为 0 ，然后接着调用 `deallocate()` 方法释放 Native Memory ，很简单也很清晰是吧，让我们再加点并发复杂度上去。

现在我们在上图步骤一与步骤二之间插入一个线程 2 ， 线程 2 对这个 ByteBuf 并发执行 `retain()` 方法。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729759126591-25ca6ef4-2fb9-4c49-b764-7a548261833a.webp)

在 4.1.17.Final 的实现中，线程 2 首先通过 getAndAdd 将 refCnt 从 0 更新为 1，紧接着线程 2 就会发现 refCnt 原来的值 oldRef 是等于 0 的，也就是说线程 2 在调用  `retain()` 的时候，ByteBuf 的引用计数已经为 0 了，并且线程 1 已经开始准备释放 Native Memory 了。

所以线程 2 需要再次调用 getAndAdd 方法将 refCnt 的值进行回退，从 1 再次回退到 0 ，最后抛出 IllegalReferenceCountException。这样的结果显然是正确的，也是符合语义的。毕竟不能对一个引用计数为 0  的 ByteBuf 调用 `retain()` 。

现在看来一切风平浪静，都是按照我们的设想有条不紊的进行，我们不妨再加点并发复杂度上去。在上图步骤 1.1 与步骤 1.2 之间在插入一个线程 3 ， 线程 3 对这个 ByteBuf 再次并发执行 `retain()` 方法。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729759251741-3d988a82-78b3-4a32-a6f2-f56fdeef5073.webp)

由于引用计数的更新（步骤 1.1）与引用计数的回退（步骤 1.2）这两个操作并不是一个原子操作，如果在这两个操作之间不巧插入了一个线程 3 ，线程 3 在并发执行 `retain()` 方法的时候，首先会通过 getAndAdd 将引用计数 refCnt 从 1 增加到 2 。

**注意，此时线程 2 还没来得及回退 refCnt ， 所以线程 3 此时看到的 refCnt 是 1 而不是 0** 。

由于此时线程 3 看到的 oldRef 是 1 ，所以线程 3 成功调用 `retain()` 方法将 ByteBuf 的引用计数增加到了 2 ，并且不会回退也不会抛出异常。在线程 3 看来此时的 ByteBuf 完完全全是一个正常可以被使用的 ByteBuf。

紧接着线程 1 开始执行步骤 2 —— `deallocate()` 方法释放 Native Memory，此后线程 3 在访问这个 ByteBuf 的时候就有问题了，因为  Native Memory 已经被线程1 释放了。

#### 2.6.5、在性能与并发安全之间的权衡

接下来，Netty 需要在性能与并发安全之间进行权衡。目前有两个选择：

第一个选择是直接回滚到 **4.1.16.Final** 版本，放弃 **XADD** 指令带来的性能提升。之前的设计中采用的 **CMPXCHG** 指令虽然性能相对较低，但不会出现上述的并发安全问题。

在 **4.1.16.Final** 版本中，Netty 在一个 **for** 循环中采用悲观策略来更新引用计数。具体流程如下：

1. 先判断异常情况。
2. 通过 **CAS** 更新 `refCnt`。

即使多个线程看到了 `refCnt` 的中间状态也没关系，因为接下来的 **CAS** 操作将会失败。例如：

- 在线程 1 对 **ByteBuf** 进行 `release` 的过程中，在执行 **CAS** 将 `refCnt` 替换为 0 之前，`refCnt` 的值是 1。
- 如果在这个间隙中，线程 2 并发执行 `retain` 方法，此时线程 2 看到的 `refCnt` 为 1，这只是一个中间状态。线程 2 执行 **CAS** 将 `refCnt` 替换为 2。
- 这时线程 1 执行 **CAS** 将会失败，但在下一轮 **for** 循环中会将 `refCnt` 替换为 1，这完全符合引用计数的语义。

另一种情况是，如果线程 1 已经执行完 **CAS** 将 `refCnt` 替换为 0，此时线程 2 去执行 `retain`。由于 **4.1.16.Final** 版本的设计是先检查异常再执行 **CAS** 替换，因此线程 2 首先会在 `retain` 方法中检查到 **ByteBuf** 的 `refCnt` 已经为 0，直接抛出 **IllegalReferenceCountException**，而不会执行 **CAS**。这同样符合引用计数的语义，因为不可以对一个引用计数已经为 0 的 **ByteBuf** 执行任何访问操作。

第二个选择是同时保留 **XADD** 指令带来的性能提升，并解决 **4.1.17.Final** 版本中引入的并发安全问题。毫无疑问，Netty 最终选择了这种方案。

在介绍 Netty 的精彩设计之前，我们应当回顾一下并发安全问题出现的根本原因。

在 **4.1.17.Final** 版本的设计中，Netty 首先通过 **getAndAdd** 方法对 `refCnt` 的值进行更新，如果出现异常情况则进行回滚。然而，这两个操作并不是原子的，因此之间的中间状态会被其他线程看到。例如：

- 线程 2 看到线程 1 的中间状态（`refCnt = 0`），于是将引用计数加到 1。在线程 2 进行回滚之前，这期间的中间状态（`refCnt = 1`，`oldRef = 0`）又被线程 3 看到，于是线程 3 将引用计数增加到了 2（`refCnt = 2`，`oldRef = 1`）。
- 这时线程 3 认为这是正常状态，但在线程 1 看来，`refCnt` 的值已经是 0，后续线程 1 就会释放 Native Memory，这就引发了问题。

问题的根本原因在于不同线程对 `refCnt` 不同的值代表不同的语义。例如，对于线程 1 来说，通过 `release` 将 `refCnt` 减至 0 时，这表示 **ByteBuf** 已经不再被引用，可以释放 Native Memory。随后，线程 2 通过 `retain` 将 `refCnt` 加至 1，改变了 **ByteBuf** 的语义，表示该 **ByteBuf** 在线程 2 中被引用了一次。最后，线程 3 再次通过 `retain` 将 `refCnt` 加至 2，进一步改变了 **ByteBuf** 的语义。

由于使用 **XADD** 指令更新引用计数不可避免地导致上述并发更新 `refCnt` 的情况，关键在于 `refCnt` 的每一次被其他线程并发修改后，**ByteBuf** 的语义就会发生改变。这正是 **4.1.17.Final** 版本中的关键问题。

如果 Netty 希望在享受 **XADD** 指令带来的性能提升的同时，解决上述提到的并发安全问题，就必须重新设计引用计数。我们的要求是继续采用 **XADD** 指令实现引用计数的更新，但这会导致多线程并发修改引起的 **ByteBuf** 语义改变。

既然多线程并发修改无法避免，那么我们能否重新设计引用计数，使得无论多线程如何修改 **ByteBuf** 的语义始终保持不变？也就是说，只要线程 1 将 `refCnt` 减至 0，无论线程 2 和线程 3 如何并发修改 `refCnt` 的值，`refCnt` 等于 0 的语义始终保持不变？

#### 2.6.6、奇偶设计的引入

在这里，Netty 采用了一种极为巧妙的设计，使引用计数的逻辑不再是简单的 0、1、2、3 等，而是将其分为两大类：偶数和奇数。

- **偶数**代表的语义是 **ByteBuf** 的 `refCnt` 不为 0。也就是说，只要一个 **ByteBuf** 仍在被引用，其 `refCnt` 就是一个偶数。具体被引用的次数可以通过 `refCnt >>> 1` 来获取。
- **奇数**代表的语义是 **ByteBuf** 的 `refCnt` 等于 0。只要一个 **ByteBuf** 没有任何地方引用它，其 `refCnt` 就是一个奇数，此时背后引用的 Native Memory 随后会被释放。

在初始化 **ByteBuf** 时，`refCnt` 不再是 1，而是被初始化为 2（偶数）。每次调用 `retain` 方法时，不再对 `refCnt` 加 1，而是加 2（偶数步长）；每次调用 `release` 方法时，不再对 `refCnt` 减 1，而是减 2（同样是偶数步长）。这样一来，只要一个 **ByteBuf** 的引用计数为偶数，无论多线程如何并发调用 `retain` 方法，其引用计数始终保持为偶数，语义也因此得以保持不变。

```java
public final int initialValue() {
    return 2;
}
```

当一个 **ByteBuf** 的引用计数降到没有任何引用时，Netty 不再将 `refCnt` 设置为 0，而是将其设置为 1（奇数）。在这种情况下，无论多线程如何并发调用 `retain` 和 `release` 方法，引用计数始终保持为奇数，**ByteBuf** 引用计数为 0 的语义得以保持不变。

让我们以上述的并发安全问题为例，在新的引用计数设计方案中，首先线程 1 对 **ByteBuf** 执行 `release` 方法，Netty 将 `refCnt` 设置为 1（奇数）。此时，线程 2 并发调用 `retain` 方法，通过 `getAndAdd` 将 `refCnt` 从 1 增加到 3。此时，`refCnt` 仍然是一个奇数，按照奇数的语义，**ByteBuf** 的引用计数实际上已经是 0，因此线程 2 在 `retain` 方法中抛出了 `IllegalReferenceCountException`。

同样，线程 3 并发调用 `retain` 方法，通过 `getAndAdd` 将 `refCnt` 从 3 增加到 5。可以看到，在新的方案设计中，无论多线程如何并发执行 `retain` 方法，`refCnt` 的值始终保持为奇数，随后线程 3 也会在 `retain` 方法中抛出 `IllegalReferenceCountException`。这种设计完全符合引用计数的并发语义。

这个新的引用计数设计方案是在 4.1.32.Final 版本中引入的，通过一个巧妙的奇偶设计，成功解决了 4.1.17.Final 版本中存在的并发安全问题。现在，我们已经明确了新方案的核心设计要素，接下来我将以 4.1.56.Final 版本为例，继续介绍新方案的实现细节。

在 Netty 中，所有的 **ByteBuf** 都继承自 `AbstractReferenceCountedByteBuf`，在这个类中实现了所有对 **ByteBuf** 引用计数的操作，而对于 `ReferenceCounted` 接口的实现也在此处完成。

```java
public abstract class AbstractReferenceCountedByteBuf extends AbstractByteBuf {
    // 获取 refCnt 字段在 ByteBuf 对象内存中的偏移
    // 后续通过 Unsafe 对 refCnt 进行操作
    private static final long REFCNT_FIELD_OFFSET =
            ReferenceCountUpdater.getUnsafeOffset(AbstractReferenceCountedByteBuf.class, "refCnt");

    // 获取 refCnt 字段 的 AtomicFieldUpdater
    // 后续通过 AtomicFieldUpdater 来操作 refCnt 字段
    private static final AtomicIntegerFieldUpdater<AbstractReferenceCountedByteBuf> AIF_UPDATER =
            AtomicIntegerFieldUpdater.newUpdater(AbstractReferenceCountedByteBuf.class, "refCnt");

    // 创建 ReferenceCountUpdater，对于引用计数的所有操作最终都会代理到这个类中
    private static final ReferenceCountUpdater<AbstractReferenceCountedByteBuf> updater =
            new ReferenceCountUpdater<AbstractReferenceCountedByteBuf>() {
        @Override
        protected AtomicIntegerFieldUpdater<AbstractReferenceCountedByteBuf> updater() {
            // 通过 AtomicIntegerFieldUpdater 操作 refCnt 字段
            return AIF_UPDATER;
        }
        @Override
        protected long unsafeOffset() {
            // 通过 Unsafe 操作 refCnt 字段
            return REFCNT_FIELD_OFFSET;
        }
    };
    // ByteBuf 中的引用计数，初始为 2 （偶数）
    private volatile int refCnt = updater.initialValue();
}
```

其中定义了一个 refCnt 字段用于记录 ByteBuf 被引用的次数，由于采用了奇偶设计，在创建 ByteBuf 的时候，Netty 会将 refCnt 初始化为 2 （偶数），它的逻辑语义是该 ByteBuf 被引用一次。后续对 ByteBuf 执行 retain 就会对 refCnt 进行加 2 ，执行 release 就会对 refCnt 进行减 2 ，对于引用计数的单次操作都是以 2 为步长进行。

由于在 Netty 中除了 AbstractReferenceCountedByteBuf 这个专门用于实现 ByteBuf 的引用计数功能之外，还有一个更加通用的引用计数抽象类 AbstractReferenceCounted，它用于实现所有系统资源类的引用计数功能（ByteBuf 只是其中的一种内存资源）。

由于都是对引用计数的实现，所以在之前的版本中，这两个类中包含了很多重复的引用计数相关操作逻辑，所以 Netty 在 4.1.35.Final  版本中专门引入了一个 ReferenceCountUpdater 类，将所有引用计数的相关实现聚合在这里。

ReferenceCountUpdater 对于引用计数 refCnt 的操作有两种方式，一种是通过 AtomicFieldUpdater 来对 refCnt 进行操作，我们可以通过 `updater()` 获取到 refCnt 字段对应的 AtomicFieldUpdater。

另一种则是通过 Unsafe 来对 refCnt 进行操作，我们可以通过 `unsafeOffset()` 来获取到 refCnt 字段在 ByteBuf 实例对象内存中的偏移。

按理来说，我们采用一种方式就可以对 refCnt 进行访问或者更新了，那为什么 Netty 提供了两种方式呢 ？会显得有点多余吗 ？这个点大家可以先思考下为什么 ，后续在我们剖析到源码细节的时候笔者在为大家解答。

好了，下面我们正式开始介绍新版引用计数设计方案的具体实现细节，第一个问题，在新的设计方案中，我们如何获取 ByteBuf 的逻辑引用计数 ？

```java
public abstract class ReferenceCountUpdater<T extends ReferenceCounted> {
    public final int initialValue() {
        // ByteBuf 引用计数初始化为 2
        return 2;
    }

    public final int refCnt(T instance) {
        // 通过 updater 获取 refCnt
        // 根据 refCnt 在  realRefCnt 中获取真实的引用计数
        return realRefCnt(updater().get(instance));
    }
    // 获取 ByteBuf 的逻辑引用计数
    private static int realRefCnt(int rawCnt) {
        // 奇偶判断
        return rawCnt != 2 && rawCnt != 4 && (rawCnt & 1) != 0 ? 0 : rawCnt >>> 1;
    }
}
```

由于采用了奇偶引用计数的设计，所以我们在获取逻辑引用计数的时候需要判断当前 rawCnt（refCnt）是奇数还是偶数，它们分别代表了不同的语义。

- 如果 rawCnt 是奇数，则表示当前 ByteBuf 已经没有任何地方引用了，逻辑引用计数返回 0.
- 如果 rawCnt 是偶数，则表示当前 ByteBuf 还有地方在引用，逻辑引用计数则为 `rawCnt >>> 1`。

realRefCnt 函数其实就是简单的一个奇偶判断逻辑，但在它的实现中却体现出了 Netty 对性能的极致追求。比如，我们判断一个数是奇数还是偶数其实很简单，直接通过  `rawCnt & 1` 就可以判断，如果返回 0 表示 rawCnt 是一个偶数，如果返回 1 表示 rawCnt 是一个奇数。

但是我们看到 Netty 在奇偶判断条件的前面又加上了 `rawCnt != 2 && rawCnt != 4 ` 语句，这是干嘛的呢 ？

其实 Netty 这里是为了尽量用性能更高的 `==` 运算来代替 `&` 运算，但又不可能用 `==` 运算来枚举出所有的偶数值（也没这必要），所以只用 `==` 运算来判断在实际场景中经常出现的引用计数，一般经常出现的引用计数值为 2 或者 4 ， 也就是说 ByteBuf 在大部分场景下只会被引用 1 次或者 2 次，对于这种高频出现的场景，Netty 用 `==` 运算来针对性优化，低频出现的场景就回退到 `&` 运算。

大部分性能优化的套路都是相同的，我们通常不能一上来就奢求一个大而全的针对全局的优化方案，这是不可能的，也是十分低效的。往往最有效的，可以立竿见影的优化方案都是针对局部热点进行专门优化。

对引用计数的设置也是一样，都需要考虑奇偶的转换，我们在 `setRefCnt` 方法中指定的参数 refCnt 表示逻辑上的引用计数 —— `0, 1 , 2 , 3 ....`，但要设置到 ByteBuf 时，就需要对逻辑引用计数在乘以 2 ，让它始终是一个偶数。

```java
public final void setRefCnt(T instance, int refCnt) {
    updater().set(instance, refCnt > 0 ? refCnt << 1 : 1); // overflow OK here
}
```

有了这些基础之后，我们下面就来看一下在新版本的 retain 方法设计中，Netty 是如何解决 4.1.17.Final 版本存在的并发安全问题。首先 Netty 对引用计数的奇偶设计对于用户来说是透明的。引用计数对于用户来说仍然是普通的自然数 —— `0, 1 , 2 , 3 ....` 。

所以每当用户调用 retain 方法试图增加 ByteBuf 的引用计数时，通常是指定逻辑增加步长 —— increment（用户视角），而在具体的实现角度，Netty 会增加两倍的 increment （rawIncrement）到 refCnt 字段中。

```java
public final T retain(T instance) {
    // 引用计数逻辑上是加 1 ，但实际上是加 2 （实现角度）
    return retain0(instance, 1, 2);
}

public final T retain(T instance, int increment) {
    // all changes to the raw count are 2x the "real" change - overflow is OK
    // rawIncrement 始终是逻辑计数 increment 的两倍
    int rawIncrement = checkPositive(increment, "increment") << 1;
    // 将 rawIncrement 设置到 ByteBuf 的 refCnt 字段中
    return retain0(instance, increment, rawIncrement);
}

// rawIncrement = increment << 1
// increment 表示引用计数的逻辑增长步长
// rawIncrement 表示引用计数的实际增长步长
private T retain0(T instance, final int increment, final int rawIncrement) {
    // 先通过 XADD 指令将  refCnt 的值加起来
    int oldRef = updater().getAndAdd(instance, rawIncrement);
    // 如果 oldRef 是一个奇数，也就是 ByteBuf 已经没有引用了，抛出异常
    if (oldRef != 2 && oldRef != 4 && (oldRef & 1) != 0) {
        // 如果 oldRef 已经是一个奇数了，无论多线程在这里怎么并发 retain ，都是一个奇数，这里都会抛出异常
        throw new IllegalReferenceCountException(0, increment);
    }
    // don't pass 0! 
    // refCnt 不可能为 0 ，只能是 1
    if ((oldRef <= 0 && oldRef + rawIncrement >= 0)
            || (oldRef >= 0 && oldRef + rawIncrement < oldRef)) {
        // 如果 refCnt 字段已经溢出，则进行回退，并抛异常
        updater().getAndAdd(instance, -rawIncrement);
        throw new IllegalReferenceCountException(realRefCnt(oldRef), increment);
    }
    return instance;
}
```

首先新版本的 retain0 方法仍然保留了 4.1.17.Final 版本引入的  XADD 指令带来的性能优势，大致的处理逻辑也是类似的，一上来先通过 getAndAdd 方法将 refCnt 增加 rawIncrement，对于 `retain(T instance)` 来说这里直接加 2 。

然后判断原来的引用计数 oldRef 是否是一个奇数，如果是一个奇数，那么就表示 ByteBuf 已经没有任何引用了，逻辑引用计数早已经为 0 了，那么就抛出 IllegalReferenceCountException。

在引用计数为奇数的情况下，无论多线程怎么对 refCnt 并发加 2 ，refCnt 始终是一个奇数，最终都会抛出异常。解决并发安全问题的要点就在这里，一定要保证 retain 方法的并发执行不能改变原来的语义。

最后会判断一下 refCnt 字段是否发生溢出，如果溢出，则进行回退，并抛出异常。下面我们仍然以之前的并发场景为例，用一个具体的例子，来回味一下奇偶设计的精妙之处。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729760530440-430cdfa8-5a36-42b5-ab7a-301bfdc5623d.webp)

现在线程 1 对一个 refCnt 为 2 的 ByteBuf 执行 release 方法，这时 ByteBuf 的逻辑引用计数就为 0 了，对于一个没有任何引用的 ByteBuf 来说，新版的设计中它的 refCnt 只能是一个奇数，不能为 0 ，所以这里 Netty 会将 refCnt 设置为 1 。然后在步骤 2 中调用 deallocate 方法释放 Native Memory。

线程 2 在步骤 1 和步骤 2 之间插入进来对  ByteBuf 并发执行 retain 方法，这时线程 2 看到的 refCnt 是 1，然后通过 getAndAdd 将 refCnt 加到了 3 ，仍然是一个奇数，随后抛出 IllegalReferenceCountException 异常。

线程 3 在步骤 1.1 和步骤 1.2 之间插入进来再次对 ByteBuf 并发执行 retain 方法，这时线程 3 看到的 refCnt 是 3，然后通过 getAndAdd 将 refCnt 加到了 5 ，还是一个奇数，随后抛出 IllegalReferenceCountException 异常。

这样一来就保证了引用计数的并发语义 —— 只要一个 ByteBuf 没有任何引用的时候（refCnt = 1），其他线程无论怎么并发执行  retain 方法都会得到一个异常。

但是引用计数并发语义的保证不能单单只靠 retain 方法，它还需要与 release 方法相互配合协作才可以，所以为了并发语义的保证 ， release 方法的设计就不能使用性能更高的 XADD 指令，而是要回退到  CMPXCHG 指令来实现。

为什么这么说呢 ？因为新版引用计数的设计采用的是奇偶实现，refCnt 为偶数表示 ByteBuf 还有引用，refCnt 为奇数表示 ByteBuf 已经没有任何引用了，可以安全释放 Native Memory 。对于一个 refCnt 已经为奇数的 ByteBuf 来说，无论多线程怎么并发执行 retain 方法，得到的 refCnt 仍然是一个奇数，最终都会抛出 IllegalReferenceCountException，这就是引用计数的并发语义 。

为了保证这一点，就需要在每次调用 retain ，release 方法的时候，以偶数步长来更新 refCnt，比如每一次调用 retain 方法就对 refCnt 加 2 ，每一次调用 release 方法就对 refCnt 减 2 。

但总有一个时刻，refCnt 会被减到 0 的对吧，在新版的奇偶设计中，refCnt 是不允许为 0 的，因为一旦 refCnt 被减到了 0 ，多线程并发执行 retain 之后，就会将 refCnt 再次加成了偶数，这又会出现并发问题。

而每一次调用 release 方法是对 refCnt 减 2 ，如果我们采用 XADD 指令实现 release 的话，回想一下 4.1.17.Final 版本中的设计，它首先进来是通过 getAndAdd 方法对 refCnt 减 2 ，这样一来，refCnt 就变成 0 了，就有并发安全问题了。所以我们需要通过 CMPXCHG 指令将 refCnt 更新为 1。

这里有的同学可能要问了，那可不可以先进行一下 if 判断，如果 refCnt 减 2 之后变为 0 了，我们在通过 getAndAdd 方法将 refCnt 更新为 1 （减一个奇数），这样一来不也可以利用上 XADD 指令的性能优势吗 ？

答案是不行的，因为 if 判断与 getAndAdd 更新这两个操作之间仍然不是原子的，多线程可以在这个间隙仍然有并发执行 retain 方法的可能，如下图所示：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729760596456-73f3d835-0c5c-423b-87c4-f20bf3036871.webp)

在线程 1 执行 if 判断和 getAndAdd 更新这两个操作之间，线程 2 看到的 refCnt 其实 2 ，然后线程 2 会将 refCnt 加到 4 ，线程 3 紧接着会将 refCnt 增加到 6 ，在线程 2 和线程 3 看来这个 ByteBuf 完全是正常的，但是线程 1 马上就会释放 Native Memory 了。

而且采用这种设计的话，一会通过 getAndAdd 对 refCnt 减一个奇数，一会通过 getAndAdd 对 refCnt 加一个偶数，这样就把原本的奇偶设计搞乱掉了。

所以我们的设计目标是一定要保证在 ByteBuf 没有任何引用计数的时候，release 方法需要原子性的将 refCnt 更新为 1 。 因此必须采用 CMPXCHG 指令来实现而不能使用 XADD 指令。

**再者说， CMPXCHG 指令是可以原子性的判断当前是否有并发情况的，如果有并发情况出现，CAS  就会失败，我们可以继续重试。但 XADD 指令却无法原子性的判断是否有并发情况，因为它每次都是先更新，后判断并发，这就不是原子的了。这一点，在下面的源码实现中会体现的特别明显**。

#### 2.6.7、尽量避免内存屏障的开销

```java
public final boolean release(T instance) {
    // 第一次尝试采用 unSafe nonVolatile 的方式读取 refCnf 的值
    int rawCnt = nonVolatileRawCnt(instance);
    // 如果逻辑引用计数被减到 0 了，那么就通过 tryFinalRelease0 使用 CAS 将 refCnf 更新为 1
    // CAS 失败的话，则通过 retryRelease0 进行重试
    // 如果逻辑引用计数不为 0 ，则通过 nonFinalRelease0 将 refCnf 减 2
    return rawCnt == 2 ? tryFinalRelease0(instance, 2) || retryRelease0(instance, 1)
            : nonFinalRelease0(instance, 1, rawCnt, toLiveRealRefCnt(rawCnt, 1));
}
```

这里有一个小的细节再次体现出 Netty 对于性能的极致追求，refCnt 字段在 ByteBuf 中被 Netty 申明为一个 volatile 字段。

```java
private volatile int refCnt = updater.initialValue();
```

我们对 refCnt 的普通读写都是要走内存屏障的，但 Netty 在 release 方法中首次读取 refCnt 的值是采用 nonVolatile 的方式，不走内存屏障，直接读取 cache line，避免了屏障开销。

```java
private int nonVolatileRawCnt(T instance) {
    // 获取 REFCNT_FIELD_OFFSET
    final long offset = unsafeOffset();
    // 通过 UnSafe 的方式来访问 refCnt ， 避免内存屏障的开销
    return offset != -1 ? PlatformDependent.getInt(instance, offset) : updater().get(instance);
}
```

那有的同学可能要问了，如果读取 refCnt 的时候不走内存屏障的话，读取到的 refCnt 不就可能是一个错误的值吗 ？

事实上确实是这样的，但 Netty 不 care , 读到一个错误的值也无所谓，因为这里的引用计数采用了奇偶设计，我们在第一次读取引用计数的时候并不需要读取到一个精确的值，既然这样我们可以直接通过 UnSafe 来读取，还能剩下一笔内存屏障的开销。

那为什么不需要一个精确的值呢 ？因为如果原来的 refCnt 是一个奇数，那无论多线程怎么并发 retain ，最终得到的还是一个奇数，我们这里只需要知道 refCnt 是一个奇数就可以直接抛 IllegalReferenceCountException 了。具体读到的是一个 3 还是一个 5 其实都无所谓。

那如果原来的 refCnt 是一个偶数呢 ？其实也无所谓，我们可能读到一个正确的值也可能读到一个错误的值，如果恰好读到一个正确的值，那更好。如果读取到一个错误的值，也无所谓，因为我们后面是用 CAS 进行更新，这样的话 CAS 就会更新失败，我们只需要在一下轮 for 循环中更新正确就可以了。

如果读取到的 refCnt 恰好是 2 ，那就意味着本次 release 之后，ByteBuf 的逻辑引用计数就为 0 了，Netty 会通过 CAS 将 refCnt 更新为 1 。

```java
private boolean tryFinalRelease0(T instance, int expectRawCnt) {
    return updater().compareAndSet(instance, expectRawCnt, 1); // any odd number will work
}
```

如果 CAS 更新失败，则表示此时有多线程可能并发对 ByteBuf 执行 retain 方法，逻辑引用计数此时可能就不为 0 了，针对这种并发情况，Netty 会在 retryRelease0 方法中进行重试，将 refCnt 减 2 。

```java
private boolean retryRelease0(T instance, int decrement) {
    for (;;) {
        // 采用 Volatile 的方式读取 refCnt
        int rawCnt = updater().get(instance), 
        // 获取逻辑引用计数，如果 refCnt 已经变为奇数，则抛出异常
        realCnt = toLiveRealRefCnt(rawCnt, decrement);
        // 如果执行完本次 release , 逻辑引用计数为 0
        if (decrement == realCnt) {
            // CAS 将 refCnt 更新为 1
            if (tryFinalRelease0(instance, rawCnt)) {
                return true;
            }
        } else if (decrement < realCnt) {
            // 原来的逻辑引用计数 realCnt 大于 1（decrement）
            // 则通过 CAS 将 refCnt 减 2
            if (updater().compareAndSet(instance, rawCnt, rawCnt - (decrement << 1))) {
                return false;
            }
        } else {
            // refCnt 字段如果发生溢出，则抛出异常
            throw new IllegalReferenceCountException(realCnt, -decrement);
        }
        // CAS 失败之后调用 yield
        // 减少无畏的竞争，否则所有线程在高并发情况下都在这里 CAS 失败
        Thread.yield(); 
    }
}
```

从 retryRelease0 方法的实现中我们可以看出，CAS 是可以原子性的探测到是否有并发情况出现的，如果有并发情况，这里的所有 CAS 都会失败，随后会在下一轮 for 循环中将正确的值更新到 refCnt 中。这一点 ，XADD 指令是做不到的。

如果在进入 release 方法后，第一次读取的 refCnt 不是 2 ，那么就不能走上面的 tryFinalRelease0 逻辑，而是在 nonFinalRelease0 中通过 CAS 将 refCnt 的值减 2 。

```java
private boolean nonFinalRelease0(T instance, int decrement, int rawCnt, int realCnt) {
    if (decrement < realCnt
            && updater().compareAndSet(instance, rawCnt, rawCnt - (decrement << 1))) {
        // ByteBuf 的 rawCnt 减少 2 * decrement
        return false;
    }
    // CAS  失败则一直重试，如果引用计数已经为 0 ，那么抛出异常，不能再次 release
    return retryRelease0(instance, decrement);
}
```

到这里，Netty 对引用计数的精彩设计，笔者就为大家完整的剖析完了，一共有四处非常精彩的优化设计，我们总结如下：

1. 使用性能更优的  XADD 指令来替换 CMPXCHG 指令。
2. 引用计数采用了奇偶设计，保证了并发语义。
3. 采用性能更优的 `==` 运算来替换 `&` 运算
4. 能不走内存屏障就尽量不走内存屏障

### 2.7、ByteBuf 的视图设计

和 JDK 的设计一样，Netty 中的 ByteBuf 也可以通过 `slice()` 方法以及 `duplicate()` 方法创建一个视图 ByteBuf 出来，原生 ByteBuf 和它的视图 ByteBuf 底层都是共用同一片内存区域，也就是说在视图 ByteBuf 上做的任何改动都会反应到原生 ByteBuf 上。同理，在原生 ByteBuf 上做的任何改动也会反应到它的视图 ByteBuf 上。我们可以将视图 ByteBuf 看做是原生 ByteBuf 的一份浅拷贝。

原生 ByteBuf 和它的视图 ByteBuf 不同的是，它们都有各自独立的 readerIndex，writerIndex，capacity，maxCapacity。

`slice()` 方法是在原生 ByteBuf 的 `[readerIndex , writerIndex)` 这段内存区域内创建一个视图 ByteBuf。也就是原生 ByteBuf 和视图 ByteBuf 共用  `[readerIndex , writerIndex)` 这段内存区域。视图 ByteBuf 的数据区域其实就是原生 ByteBuf 的可读字节区域。

视图 ByteBuf 的 readerIndex = 0 ， writerIndex = capacity = maxCapacity = 原生 ByteBuf 的 `readableBytes()` 。

```java
@Override
public int readableBytes() {
    // 原生 ByteBuf
    return writerIndex - readerIndex;
}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729761212148-c9f97a36-e6e6-4661-95e9-34a12c2a1ca7.webp)

下面我们来看一下 `slice() ` 方法创建视图 ByteBuf 的逻辑实现：

```java
public abstract class AbstractByteBuf extends ByteBuf {
    @Override
    public ByteBuf slice() {
        return slice(readerIndex, readableBytes());
    }

    @Override
    public ByteBuf slice(int index, int length) {
        // 确保 ByteBuf 的引用计数不为 0 
        ensureAccessible();
        return new UnpooledSlicedByteBuf(this, index, length);
    }
}
```

Netty 会将 slice 视图 ByteBuf 封装在 UnpooledSlicedByteBuf 类中，在这里会初始化 slice 视图 ByteBuf 的 readerIndex，writerIndex，capacity，maxCapacity。

```java
class UnpooledSlicedByteBuf extends AbstractUnpooledSlicedByteBuf {
    UnpooledSlicedByteBuf(AbstractByteBuf buffer, int index, int length) {
        // index = readerIndex
        // length = readableBytes()
        super(buffer, index, length);
    }

    @Override
    public int capacity() {
        // 视图 ByteBuf 的 capacity 和 maxCapacity 相等
        // 均为原生 ByteBuf 的 readableBytes() 
        return maxCapacity();
    }
}
```

如上图所示，这里的 index 就是原生 ByteBuf 的 readerIndex = 4 ，index 用于表示视图 ByteBuf 的内存区域相对于原生 ByteBuf 的偏移，因为视图 ByteBuf 与原生 ByteBuf 共用的是同一片内存区域，针对视图 ByteBuf 的操作其实底层最终是转换为对原生 ByteBuf 的操作。

但由于视图 ByteBuf  和原生 ByteBuf 各自都有独立的 readerIndex 和 writerIndex，比如上图中，视图 ByteBuf 中的 readerIndex = 0 其实指向的是原生 ByteBuf 中 readerIndex = 4 的位置。所以每次在我们对视图 ByteBuf 进行读写的时候都需要将视图 ByteBuf 的 readerIndex 加上一个偏移（index）转换成原生 ByteBuf 的 readerIndex，近而从原生 ByteBuf 中来读写数据。

```java
@Override
protected byte _getByte(int index) {
    // 底层其实是对原生 ByteBuf 的访问
    return unwrap()._getByte(idx(index));
}

@Override
protected void _setByte(int index, int value) {
    unwrap()._setByte(idx(index), value);
}

/**
 * Returns the index with the needed adjustment.
 */
final int idx(int index) {
    // 转换为原生 ByteBuf 的 readerIndex 或者 writerIndex
    return index + adjustment;
}
```

`idx(int index)` 方法中的 adjustment 就是上面 UnpooledSlicedByteBuf 构造函数中的 index 偏移，初始化为原生 ByteBuf 的 readerIndex。

length 则初始化为原生 ByteBuf 的 `readableBytes()`，视图 ByteBuf 中的 writerIndex，capacity，maxCapacity 都是用 length 来初始化。

```java
abstract class AbstractUnpooledSlicedByteBuf extends AbstractDerivedByteBuf {
    // 原生 ByteBuf
    private final ByteBuf buffer;
    // 视图 ByteBuf 相对于原生 ByteBuf的数据区域偏移
    private final int adjustment;

    AbstractUnpooledSlicedByteBuf(ByteBuf buffer, int index, int length) {
        // 设置视图 ByteBuf 的 maxCapacity，readerIndex 为 0 
        super(length);
        // 原生 ByteBuf
        this.buffer = buffer;
        // 数据偏移为原生 ByteBuf 的 readerIndex
        adjustment = index;
        // 设置视图 ByteBuf 的 writerIndex
        writerIndex(length);
    }
}
```

但是通过 `slice()` 方法创建出来的视图 ByteBuf 并不会改变原生 ByteBuf 的引用计数，这会存在一个问题，就是由于视图 ByteBuf 和原生 ByteBuf 底层共用的是同一片内存区域，在原生 ByteBuf 或者视图 ByteBuf 各自的应用上下文中他们可能并不会意识到对方的存在。

如果对原生 ByteBuf 调用 release 方法，恰好引用计数就为 0 了，接着就会释放原生 ByteBuf 的 Native Memory 。此时再对视图 ByteBuf 进行访问就有问题了，因为  Native Memory 已经被原生 ByteBuf 释放了。同样的道理，对视图 ByteBuf 调用 release 方法 ，也会对原生 ByteBuf 产生影响。

为此 Netty 提供了一个 `retainedSlice()` 方法，在创建 slice 视图 ByteBuf 的同时对原生 ByteBuf 的引用计数加 1 ，两者共用同一个引用计数。

```java
@Override
public ByteBuf retainedSlice() {
    // 原生 ByteBuf 的引用计数加 1
    return slice().retain();
}
```

除了 `slice()` 之外，Netty 也提供了 `duplicate()` 方法来创建视图 ByteBuf 。

```java
@Override
public ByteBuf duplicate() {
    // 确保 ByteBuf 的引用计数不为 0 
    ensureAccessible();
    return new UnpooledDuplicatedByteBuf(this);
}
```

但和  `slice()` 不同的是， `duplicate()` 是完全复刻了原生 ByteBuf，复刻出来的视图 ByteBuf 虽然与原生 ByteBuf 都有各自独立的  readerIndex，writerIndex，capacity，maxCapacity。但他们的值都是相同的。duplicate 视图  ByteBuf 也是和原生 ByteBuf 共用同一块 Native Memory 。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729761376905-b89c8471-dd35-4284-a8e3-2dc2d96265af.webp)

```java
public class DuplicatedByteBuf extends AbstractDerivedByteBuf {
    // 原生 ByteBuf
    private final ByteBuf buffer;

    public DuplicatedByteBuf(ByteBuf buffer) {
        this(buffer, buffer.readerIndex(), buffer.writerIndex());
    }

    DuplicatedByteBuf(ByteBuf buffer, int readerIndex, int writerIndex) {
        // 初始化视图 ByteBuf 的 maxCapacity 与原生的相同
        super(buffer.maxCapacity());
        // 原生 ByteBuf
        this.buffer = buffer;
        // 视图 ByteBuf 的 readerIndex ， writerIndex 也与原生相同
        setIndex(readerIndex, writerIndex);
        markReaderIndex();
        markWriterIndex();
    }

    @Override
    public int capacity() {
        // 视图 ByteBuf 的 capacity 也与原生相同
        return unwrap().capacity();
    }

}
```

Netty 同样也提供了对应的 `retainedDuplicate()` 方法，用于创建 duplicate 视图 ByteBuf  的同时增加原生 ByteBuf 的引用计数。视图 ByteBuf 与原生 ByteBuf 之间共用同一个引用计数。

```java
@Override
public ByteBuf retainedDuplicate() {
    return duplicate().retain();
}
```

上面介绍的两种视图 ByteBuf 可以理解为是对原生 ByteBuf 的一层浅拷贝，Netty 也提供了 `copy()` 方法来实现对原生 ByteBuf 的深拷贝，copy 出来的 ByteBuf 是原生  ByteBuf 的一个副本，两者底层依赖的 Native Memory 是不同的，各自都有独立的  readerIndex，writerIndex，capacity，maxCapacity 。

```java
public abstract class AbstractByteBuf extends ByteBuf {
    @Override
    public ByteBuf copy() {
        // 从原生 ByteBuf 中的 readerIndex 开始，拷贝 readableBytes 个字节到新的 ByteBuf 中
        return copy(readerIndex, readableBytes());
    }
}
```

`copy()` 方法是对原生 ByteBuf 的 `[readerIndex , writerIndex)`这段数据范围内容进行拷贝。copy 出来的 ByteBuf，它的 readerIndex = 0 ， writerIndex = capacity = 原生 ByteBuf 的 `readableBytes()`。maxCapacity 与原生 maxCapacity 相同。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729761424396-1f50731f-1faa-4966-ba03-15be099baf98.webp)

```java
public class UnpooledDirectByteBuf  {
  @Override
    public ByteBuf copy(int index, int length) {
        ensureAccessible();
        ByteBuffer src;
        try {
            // 将原生 ByteBuf 中 [index , index + lengh) 这段范围的数据拷贝到新的 ByteBuf 中
            src = (ByteBuffer) buffer.duplicate().clear().position(index).limit(index + length);
        } catch (IllegalArgumentException ignored) {
            throw new IndexOutOfBoundsException("Too many bytes to read - Need " + (index + length));
        }
        // 首先新申请一段 native memory , 新的 ByteBuf 初始容量为 length (真实容量)，最大容量与原生 ByteBuf 的 maxCapacity 相等
        // readerIndex = 0 , writerIndex = length
        return alloc().directBuffer(length, maxCapacity()).writeBytes(src);
    }
}
```

### 2.8、CompositeByteBuf 的零拷贝设计

这里的零拷贝并不是我们经常提到的那种 OS 层面上的零拷贝，而是 Netty 在用户态层面自己实现的避免内存拷贝的设计。比如在传统意义上，如果我们想要将多个独立的 ByteBuf  聚合成一个 ByteBuf 的时候，我们首先需要向 OS 申请一段更大的内存，然后依次将多个 ByteBuf 中的内容拷贝到这段新申请的内存上，最后在释放这些 ByteBuf 的内存。

这样一来就涉及到两个性能开销点，一个是我们需要向 OS 重新申请更大的内存，另一个是内存的拷贝。Netty 引入 CompositeByteBuf 的目的就是为了解决这两个问题。巧妙地利用原有 ByteBuf 所占的内存，在此基础之上，将它们组合成一个逻辑意义上的 CompositeByteBuf ，提供一个统一的逻辑视图。

CompositeByteBuf 其实也是一种视图 ByteBuf ，这一点和上小节中我们介绍的 SlicedByteBuf ， DuplicatedByteBuf 一样，它们本身并不会占用 Native Memory，底层数据的存储全部依赖于原生的 ByteBuf。

不同点在于，SlicedByteBuf，DuplicatedByteBuf 它们是在单一的原生 ByteBuf 基础之上创建出的视图 ByteBuf。而 CompositeByteBuf 是基于多个原生 ByteBuf 创建出的统一逻辑视图  ByteBuf。

CompositeByteBuf 对于我们用户来说和其他的普通 ByteBuf 没有任何区别，有自己独立的 readerIndex，writerIndex，capacity，maxCapacity，前面几个小节中介绍的各种 ByteBuf 的设计要素，在 CompositeByteBuf 身上也都会体现。

但从实现的角度来说，CompositeByteBuf 只是一个**逻辑上**的 ByteBuf，其本身并不会占用任何的 Native Memory ，对于 CompositeByteBuf 的任何操作，最终都需要转换到其内部具体的 ByteBuf 上。本小节我们就来深入到 CompositeByteBuf 的内部，来看一下 Netty 的巧妙设计。

#### 2.8.1、CompositeByteBuf 的总体架构

从总体设计上来讲，CompositeByteBuf 包含如下五个重要属性，其中最为核心的就是 components 数组，那些需要被聚合的原生 ByteBuf 会被 Netty 封装在 Component 类中，并统一组织在 components 数组中。后续针对 CompositeByteBuf 的所有操作都需要和这个数组打交道。

```java
public class CompositeByteBuf extends AbstractReferenceCountedByteBuf implements Iterable<ByteBuf> {
    // 内部 ByteBuf 的分配器，用于后续扩容，copy , 合并等操作
    private final ByteBufAllocator alloc;
    // compositeDirectBuffer 还是 compositeHeapBuffer ?
    private final boolean direct;
    // 最大的 components 数组容量（16）
    private final int maxNumComponents;
    // 当前 CompositeByteBuf 中包含的 components 个数
    private int componentCount;
    // 存储 component 的数组
    private Component[] components; // resized when needed
}
```

maxNumComponents 表示 components 数组最大的容量，CompositeByteBuf 默认能够包含 Component 的最大个数为 16，如果超过这个数量的话，Netty 会将当前 CompositeByteBuf 中包含的所有 Components 重新合并成一个更大的 Component。

```java
public abstract class AbstractByteBufAllocator implements ByteBufAllocator {
    static final int DEFAULT_MAX_COMPONENTS = 16;
}
```

componentCount 表示当前 CompositeByteBuf 中包含的 Component 个数。每当我们通过 `addComponent`  方法向 CompositeByteBuf 添加一个新的 ByteBuf 时，Netty 都会用一个新的 Component 实例来包装这个 ByteBuf，然后存放在  components 数组中，最后 componentCount 的个数加 1 。

CompositeByteBuf 与其底层聚合的真实 ByteBuf 架构设计关系，如下图所示：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729762321300-b7b794f9-0ce6-435b-9a61-22beb7cd8b59.webp)

而创建一个 CompositeByteBuf 的核心其实就是创建底层的 components 数组，后续添加到该 CompositeByteBuf 的所有原生 ByteBuf 都会被组织在这里。

```java
private CompositeByteBuf(ByteBufAllocator alloc, boolean direct, int maxNumComponents, int initSize) {
    // 设置 maxCapacity
    super(AbstractByteBufAllocator.DEFAULT_MAX_CAPACITY);

    this.alloc = ObjectUtil.checkNotNull(alloc, "alloc");
    this.direct = direct;
    this.maxNumComponents = maxNumComponents;
    // 初始 Component 数组的容量为 maxNumComponents
    components = newCompArray(initSize, maxNumComponents);
}
```

这里的参数  `initSize` 表示的并不是 CompositeByteBuf 所包含的字节数，而是初始包装的原生 ByteBuf 个数，也就是初始  Component 的个数。components 数组的总体大小由参数 maxNumComponents 决定，但不能超过 16 。

```java
private static Component[] newCompArray(int initComponents, int maxNumComponents) {
    // MAX_COMPONENT
    int capacityGuess = Math.min(AbstractByteBufAllocator.DEFAULT_MAX_COMPONENTS, maxNumComponents);
    // 初始 Component 数组的容量为 maxNumComponents
    return new Component[Math.max(initComponents, capacityGuess)];
}
```

现在我们只是清楚了 CompositeByteBuf 的一个基本骨架，那么接下来 Netty 如何根据这个基本的骨架将多个原生 ByteBuf 组装成一个逻辑上的统一视图 ByteBuf 呢 ？

也就是说我们依据 CompositeByteBuf 中的 readerIndex 以及 writerIndex 进行的读写操作逻辑如何转换到对应的底层原生 ByteBuf 之上呢 ？ 这个是整个设计的核心所在。

下面笔者就带着大家从外到内，从易到难地一一拆解 CompositeByteBuf 中的那些核心设计要素。从 CompositeByteBuf 的最外层来看，其实我们并不陌生，对于用户来说它就是一个普通的 ByteBuf，拥有自己独立的 readerIndex ，writerIndex 。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729762475060-17c9afc7-0704-4cbd-853c-9366046e21a9.webp)

但 CompositeByteBuf 中那些逻辑上看起来连续的字节，背后其实存储在不同的原生 ByteBuf 中。不同 ByteBuf 的内存之间其实是不连续的。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729762505293-59797861-b9e1-474e-a060-9d90fee8f4a0.webp)

那么现在问题的关键就是我们如何判断 CompositeByteBuf 中的某一段逻辑数据背后对应的究竟是哪一个真实的 ByteBuf，如果我们能够通过 CompositeByteBuf 的相关 Index , 找到这个 Index 背后对应的 ByteBuf，近而可以找到 ByteBuf 的 Index ，这样是不是就可以将 CompositeByteBuf 的逻辑操作转换成对真实内存的读写操作了。

CompositeByteBuf 到原生 ByteBuf 的转换关系，Netty 封装在 Component 类中，每一个被包装在 CompositeByteBuf 中的原生 ByteBuf 都对应一个 Component 实例。它们会按照顺序统一组织在 components 数组中。

```java
private static final class Component {
        // 原生 ByteBuf
        final ByteBuf srcBuf; 
        // CompositeByteBuf 的 index 加上 srcAdjustment 就得到了srcBuf 的相关 index
        int srcAdjustment; 
        // srcBuf 可能是一个被包装过的 ByteBuf，比如 SlicedByteBuf ， DuplicatedByteBuf
        // 被 srcBuf 包装的最底层的 ByteBuf 就存放在 buf 字段中
        final ByteBuf buf;      
        // CompositeByteBuf 的 index 加上 adjustment 就得到了 buf 的相关 index      
        int adjustment; 
 
        // 该 Component 在 CompositeByteBuf 视角中表示的数据范围 [offset , endOffset)
        int offset; 
        int endOffset;        
    }
```

一个 Component 在 CompositeByteBuf 的视角中所能表示的数据逻辑范围是 `[offset , endOffset)`。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729762565037-56e2cfe1-0f0f-42b6-bbd6-6c256005e3bd.webp)

比如上图中第一个绿色的 ByteBuf , 它里边存储的数据组成了 CompositeByteBuf 中 `[0 , 4)` 这段逻辑数据范围。第二个黄色的 ByteBuf，它里边存储的数据组成了 CompositeByteBuf 中 `[4 , 8)` 这段逻辑数据范围。第三个蓝色的 ByteBuf，它里边存储的数据组成了 CompositeByteBuf 中 `[8 , 12)` 这段逻辑数据范围。 上一个 Component 的 endOffset 恰好是下一个 Component 的 offset 。

而这些真实存储数据的 ByteBuf 则存储在对应 Component 中的 srcBuf 字段中，当我们通过 CompositeByteBuf 的 readerIndex 或者 writerIndex 进行读写操作的时候，首先需要确定相关 index 所对应的 srcBuf，然后将 CompositeByteBuf 的 index 转换为 srcBuf 的 srcIndex，近而通过 srcIndex 对 srcBuf 进行读写。

这个 index 的转换就是通过 srcAdjustment 来进行的，比如，当前 CompositeByteBuf 的 readerIndex 为 5 ，它对应的是第二个黄色的 ByteBuf。而 ByteBuf 的 readerIndex 却是 1 。

所以第二个 Component 的 srcAdjustment 就是 -4 ， 这样我们读取 CompositeByteBuf 的时候，首先将它的 readerIndex 加上 srcAdjustment 就得到了 ByteBuf 的 readerIndex ，后面就是普通的 ByteBuf 读取操作了。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729762574453-5e43e531-2b18-40cc-b5b2-027738bb3966.webp)

在比如说，我们要对 CompositeByteBuf 进行写操作，当前的 writerIndex 为 10 ，对应的是第三个蓝色的 ByteBuf，它的 writerIndex 为 2 。

所以第三个 Component 的 srcAdjustment 就是 -8 ，CompositeByteBuf 的 writerIndex 加上 srcAdjustment 就得到了 ByteBuf 的 writerIndex，后续就是普通的 ByteBuf 写入操作。

```java
int srcIdx(int index) {
    // CompositeByteBuf 相关的 index 转换成 srcBuf 的相关 index
    return index + srcAdjustment;
}
```

除了 srcBuf 之外，Component 实例中还有一个 buf 字段，这里大家可能会比较好奇，为什么设计了两个 ByteBuf 字段呢 ？Component 实例与 ByteBuf 不是一对一的关系吗 ？

srcBuf 是指我们通过 `addComponent` 方法添加到 CompositeByteBuf 中的原始 ByteBuf。而这个 srcBuf 可能是一个视图 ByteBuf，比如上一小节中介绍到的 SlicedByteBuf 和 DuplicatedByteBuf。srcBuf 还可能是一个被包装过的 ByteBuf，比如 WrappedByteBuf , SwappedByteBuf。

假如 srcBuf 是一个 SlicedByteBuf 的话，我们需要将它的原生 ByteBuf 拆解出来并保存在 Component 实例的 buf 字段中。事实上 Component 中的 buf 才是真正存储数据的地方。

```java
abstract class AbstractUnpooledSlicedByteBuf {
    // 原生 ByteBuf
    private final ByteBuf buffer;
}
```

与 buf 对应的就是 adjustment ， 它用于将 CompositeByteBuf 的相关 index 转换成 buf 相关的 index ，假如我们在向一个 CompositeByteBuf 执行 read 操作，它的当前 readerIndex 是 5，而 buf 的 readerIndex 是 6 。

所以在读取操作之前，我们需要将 CompositeByteBuf 的 readerIndex 加上 adjustment 得到 buf 的 readerIndex，近而将读取操作转移到 buf 中。其实就和上小节中介绍的视图 ByteBuf 是一模一样的，在读写之前都需要修正相关的 index 。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729762678630-3254bc34-f3ef-48ab-b04c-4ce71270744a.webp)

```java
@Override
public byte getByte(int index) {
    // 通过 CompositeByteBuf 的 index , 找到数据所属的 component
    Component c = findComponent(index);
    // 首先通过 idx 转换为 buf 相关的 index
    // 将对 CompositeByteBuf 的读写操作转换为 buf 的读写操作
    return c.buf.getByte(c.idx(index));
}

int idx(int index) {
    // 将 CompositeByteBuf 的相关 index 转换为 buf 的相关 index
    return index + adjustment;
 }
```

那么我们如何根据指定的 CompositeByteBuf 的 index 来查找其对应的底层数据究竟存储在哪个 Component 中呢 ？

核心思想其实很简单，因为每个 Component 都会描述自己表示 CompositeByteBuf 中的哪一段数据范围 —— `[offset , endOffset)`。所有的 Components 都被有序的组织在 components 数组中。我们可以通过二分查找的方法来寻找这个 index 到底是落在了哪个 Component 表示的范围中。

这个查找的过程是在 `findComponent ` 方法中实现的，Netty 会将最近一次访问到的  Component 缓存在 CompositeByteBuf 的 lastAccessed 字段中，每次进行查找的时候首先会判断 index 是否落在了 lastAccessed 所表示的数据范围内 —— `[ la.offset , la.endOffset)` 。

如果 index 恰好被缓存的 Component（lastAccessed）所包含，那么就直接返回 lastAccessed 。

```java
// 缓存最近一次查找到的 Component
private Component lastAccessed;

private Component findComponent(int offset) {
    Component la = lastAccessed;
    // 首先查找 offset 是否恰好落在 lastAccessed 的区间中
    if (la != null && offset >= la.offset && offset < la.endOffset) {
       return la;
    }
    // 在所有 Components 中进行二分查找
    return findIt(offset);
}
```

如果 index 不巧没有命中缓存，那么就在整个 components 数组中进行二分查找 ：

```java
private Component findIt(int offset) {
    for (int low = 0, high = componentCount; low <= high;) {
        int mid = low + high >>> 1;
        Component c = components[mid];
        if (offset >= c.endOffset) {
            low = mid + 1;
        } else if (offset < c.offset) {
            high = mid - 1;
        } else {
            lastAccessed = c;
            return c;
        }
    }

    throw new Error("should not reach here");
}
```

#### 2.8.2、CompositeByteBuf 的创建

好了，现在我们已经熟悉了 CompositeByteBuf 的总体架构，那么接下来我们就来看一下 Netty 是如何将多个 ByteBuf 逻辑聚合成一个 CompositeByteBuf 的

```java
public final class Unpooled {
   public static ByteBuf wrappedBuffer(ByteBuf... buffers) {
        return wrappedBuffer(buffers.length, buffers);
    }
}
```

CompositeByteBuf 的初始 maxNumComponents 为 buffers 数组的长度，如果我们只是传入一个 ByteBuf 的话，那么就无需创建 CompositeByteBuf，而是直接返回该 ByteBuf 的 slice 视图。

如果我们传入的是多个 ByteBuf 的话，则将这多个 ByteBuf 包装成 CompositeByteBuf 返回。

```java
public final class Unpooled {
    public static ByteBuf wrappedBuffer(int maxNumComponents, ByteBuf... buffers) {
        switch (buffers.length) {
        case 0:
            break;
        case 1:
            ByteBuf buffer = buffers[0];
            if (buffer.isReadable()) {
                // 直接返回 buffer.slice() 视图
                return wrappedBuffer(buffer.order(BIG_ENDIAN));
            } else {
                buffer.release();
            }
            break;
        default:
            for (int i = 0; i < buffers.length; i++) {
                ByteBuf buf = buffers[i];
                if (buf.isReadable()) {
                    // 从第一个可读的 ByteBuf —— buffers[i] 开始创建 CompositeByteBuf
                    return new CompositeByteBuf(ALLOC, false, maxNumComponents, buffers, i);
                }
                // buf 不可读则 release
                buf.release();
            }
            break;
        }
        return EMPTY_BUFFER;
    }
}
```

在进入 CompositeByteBuf 的创建流程之后，首先是创建出一个空的 CompositeByteBuf，也就是先把 CompositeByteBuf 的骨架搭建起来，这时它的 initSize 为 `buffers.length - offset` 。

注意 initSize 表示的并不是 CompositeByteBuf 初始包含的字节个数，而是表示初始 Component 的个数。offset 则表示从 buffers 数组中的哪一个索引开始创建 CompositeByteBuf，就是上面 CompositeByteBuf 构造函数中最后一个参数 i 。

随后通过 `addComponents0` 方法为 buffers 数组中的每一个 ByteBuf 创建初始化 Component 实例，并将他们有序的添加到 CompositeByteBuf 的 components 数组中。

但这时 Component 实例的个数可能已经超过 maxNumComponents 限制的个数，那么接下来就会在 `consolidateIfNeeded()` 方法中将当前 CompositeByteBuf 中的所有 Components 合并成一个更大的 Component。CompositeByteBuf 中的 components 数组长度是不可以超过 maxNumComponents 限制的，如果超过就需要在这里合并。

最后设置当前 CompositeByteBuf 的 readerIndex 和 writerIndex，在初始状态下 CompositeByteBuf 的 readerIndex 会被设置为 0 ，writerIndex 会被设置为最后一个 Component 的 endOffset 。

```java
CompositeByteBuf(ByteBufAllocator alloc, boolean direct, int maxNumComponents,
        ByteBuf[] buffers, int offset) {
    // 先初始化一个空的 CompositeByteBuf
    // initSize 为 buffers.length - offset
    this(alloc, direct, maxNumComponents, buffers.length - offset);
    // 为所有的 buffers 创建  Component 实例，并添加到 components 数组中
    addComponents0(false, 0, buffers, offset);
    // 如果当前 component 的个数已经超过了 maxNumComponents，则将所有 component 合并成一个
    consolidateIfNeeded();
    // 设置 CompositeByteBuf 的 readerIndex = 0
    // writerIndex 为最后一个 component 的 endOffset
    setIndex0(0, capacity());
}
```

#### 2.8.3、shiftComps 为新的 ByteBuf 腾挪空间

在整个 CompositeByteBuf 的构造过程中，最核心也是最复杂的步骤其实就是 `addComponents0` 方法，将多个 ByteBuf  有序的添加到 CompositeByteBuf 的 components 数组中看似简单，其实还有很多种复杂的情况需要考虑。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729762932037-00b1f742-43b8-479c-bf49-49645be4a9b5.webp)

复杂之处在于这些 ByteBuf 需要插在 components 数组的哪个位置上 ？ 比较简单直观的情况是我们直接在 components 数组的末尾插入，也就是说要插入的位置索引 cIndex 等于 componentCount。这里分为两种情况：

- `cIndex = componentCount = 0` ，这种情况表示我们在向一个空的 CompositeByteBuf 插入 ByteBufs , 很简单，直接插入即可。
- `cIndex = componentCount > 0` ， 这种情况表示我们再向一个非空的 CompositeByteBuf 插入 ByteBufs，正如上图所示。同样也很简单，直接在 componentCount 的位置处插入即可。

稍微复杂一点的情况是我们在 components 数组的中间位置进行插入而不是在末尾，也就是 `cIndex < componentCount` 的情况。如下如图所示，假设我们现在需要在 `cIndex = 3 ` 的位置处插入两个 ByteBuf 进来，但现在 components[3] 以及 components[4] 的位置已经被占用了。所以我们需要将这两个位置上的原有 component 向后移动两个位置，将 components[3] 和 components[4] 的位置腾出来。

```java
// i = 3 , count = 2 , size = 5
System.arraycopy(components, i, components, i + count, size - i);
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729763010694-eb1f5e7f-7623-4203-96a9-6ff5bdfb33e7.webp)

在复杂一点的情况就是 components 数组需要扩容，当一个 CompositeByteBuf 刚刚被初始化出来的时候，它的 components 数组长度等于 maxNumComponents。

如果当前 components 数组中包含的 component 个数 —— componentCount 加上本次需要添加的 ByteBuf 个数 —— count 已经超过了 maxNumComponents 的时候，就需要对 components 数组进行扩容。

```java
// 初始为 0，当前 CompositeByteBuf 中包含的 component 个数
final int size = componentCount, 
// 本次 addComponents0 操作之后，新的 component 个数
newSize = size + count;

// newSize 超过了 maxNumComponents 则对 components 数组进行扩容
if (newSize > components.length) {
    ....... 扩容 ....

    // 扩容后的新数组
    components = newArr;
}
```

扩容之后的 components 数组长度是在 newSize 与原来长度的 `3 / 2 ` 之间取一个最大值。

```java
int newArrSize = Math.max(size + (size >> 1), newSize);
```

如果我们原来恰好是希望在 components 数组的末尾插入，也就是 `cIndex = componentCount` 的情况，那么就需要通过 `Arrays.copyOf` 首先申请一段长度为 newArrSize 的数组，然后将原来的 components 数组中的内容原样拷贝过去。

```java
newArr = Arrays.copyOf(components, newArrSize, Component[].class);
```

这样新的 components 数组就有位置可以容纳本次需要加入的 ByteBuf 了。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729763074491-ec21182d-c4bc-4414-b255-8795b8345c91.webp)

如果我们希望在原来 components 数组的中间插入，也就是 `cIndex < componentCount` 的情况，如下图所示：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729763086150-df62f958-1838-4b01-ad63-ee5e682d4c0c.webp)

这种情况在扩容的时候就不能原样拷贝原 components 数组了，而是首先通过 `System.arraycopy` 将 `[0 , cIndex)` 这段范围的内容拷贝过去，在将 `[cIndex , componentCount) `这段范围的内容拷贝到新数组的 `cIndex + count` 位置处。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729763104343-96be9117-668e-447d-83af-a937035dc77b.webp)

这样一来，就在新 components 数组的 cIndex 索引处，空出了两个位置出来用来添加本次这两个 ByteBuf。最后更新 componentCount 的值。以上腾挪空间的逻辑封装在 shiftComps 方法中：

```java
private void shiftComps(int i, int count) {
    // 初始为 0，当前 CompositeByteBuf 中包含的 component 个数
    final int size = componentCount, 
    // 本次 addComponents0 操作之后，新的 component 个数
    newSize = size + count;
   
    // newSize 超过了 max components（16） 则对 components 数组进行扩容
    if (newSize > components.length) {
        // grow the array，扩容到原来的 3 / 2
        int newArrSize = Math.max(size + (size >> 1), newSize);
        Component[] newArr;
        if (i == size) {
            // 在 Component[] 数组的末尾进行插入
            // 初始状态 i = size = 0
            // size - 1 是 Component[] 数组的最后一个元素，指定的 i 恰好越界
            // 原来 Component[] 数组中的内容全部拷贝到 newArr 中
            newArr = Arrays.copyOf(components, newArrSize, Component[].class);
        } else {
            // 在 Component[] 数组的中间进行插入
            newArr = new Component[newArrSize];
            if (i > 0) {
                // [0 , i) 之间的内容拷贝到 newArr 中
                System.arraycopy(components, 0, newArr, 0, i);
            }
            if (i < size) {
                // 将剩下的 [i , size) 内容从 newArr 的 i + count 位置处开始拷贝。
                // 因为需要将原来的 [ i , i+count ） 这些位置让出来，添加本次新的 components，
                System.arraycopy(components, i, newArr, i + count, size - i);
            }
        }
        // 扩容后的新数组
        components = newArr;
    } else if (i < size) {
        // i < size 本次操作要覆盖原来的 [ i , i+count ） 之间的位置，所以这里需要将原来位置上的 component 向后移动
        System.arraycopy(components, i, components, i + count, size - i);
    }
    // 更新 componentCount
    componentCount = newSize;
}
```

#### 2.8.4、Component 如何封装 ByteBuf

经过上一小节 shiftComps 方法的辗转腾挪之后，现在 CompositeByteBuf 中的 components 数组终于有位置可以容纳本次需要添加的 ByteBuf 了。接下来就需要为每一个 ByteBuf 创建初始化一个 Component 实例，最后将这些 Component 实例放到 components 数组对应的位置上。

```java
private static final class Component {
    // 原生 ByteBuf
    final ByteBuf srcBuf; 
    // CompositeByteBuf 的 index 加上 srcAdjustment 就得到了srcBuf 的相关 index
    int srcAdjustment; 
    // srcBuf 可能是一个被包装过的 ByteBuf，比如 SlicedByteBuf ， DuplicatedByteBuf
    // 被 srcBuf 包装的最底层的 ByteBuf 就存放在 buf 字段中
    final ByteBuf buf;      
    // CompositeByteBuf 的 index 加上 adjustment 就得到了 buf 的相关 index      
    int adjustment; 

    // 该 Component 在 CompositeByteBuf 视角中表示的数据范围 [offset , endOffset)
    int offset; 
    int endOffset;        
}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729763162764-c55d6ae4-266e-4b09-8a8a-bbd2ecd5c015.webp)

我们首先需要初始化 Component 实例的 offset ， endOffset 属性，前面我们已经介绍了，一个 Component 在 CompositeByteBuf 的视角中所能表示的数据逻辑范围是 `[offset , endOffset)`。在 components 数组中，一般前一个 Component 的 endOffset 往往是后一个 Component 的 offset。

如果我们期望从 components 数组的第一个位置处开始插入（cIndex = 0），那么第一个 Component 的 offset 自然是 0 。

如果 cIndex > 0 , 那么我们就需要找到它上一个 Component —— components[cIndex - 1] ， 上一个 Component 的 endOffset 恰好就是当前 Component 的 offset。

然后通过 `newComponent` 方法利用 ByteBuf 相关属性以及 offset 来初始化 Component 实例。随后将创建出来的 Component 实例放置在对应的位置上 —— components[cIndex] 。

```java
// 获取当前正在插入 Component 的 offset
int nextOffset = cIndex > 0 ? components[cIndex - 1].endOffset : 0;
for (ci = cIndex; arrOffset < len; arrOffset++, ci++) {
    // 待插入 ByteBuf
    ByteBuf b = buffers[arrOffset];
    if (b == null) {
        break;
    }
    // 将 ByteBuf 封装在 Component 中
    Component c = newComponent(ensureAccessible(b), nextOffset);
    components[ci] = c;
    // 下一个 Component 的 Offset 是上一个 Component 的 endOffset
    nextOffset = c.endOffset;
}
```

假设现在有一个空的 CompositeByteBuf，我们需要将一个数据范围为 `[1 , 4]` , readerIndex = 1 的 srcBuf ， 插入到 CompositeByteBuf 的 components 数组中。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729763234312-79480d8c-f451-4518-9a43-4bdc639e7a2e.webp)

但是如果该 srcBuf 是一个视图 ByteBuf 的话，比如：SlicedByteBuf ， DuplicatedByteBuf。或者是一个被包装过的 ByteBuf ，比如：WrappedByteBuf ， SwappedByteBuf。

那么我们就需要对 srcBuf 不断的执行 `unwrap()`, 将其最底层的原生 ByteBuf 提取出来，如上图所示，原生 buf 的数据范围为 `[4 , 7]` , srcBuf 与 buf 之间相关 index 的偏移 adjustment 等于 3  , 原生 buf 的 readerIndex = 4 。

最后我们会根据 srcBuf ， srcIndex（srcBuf 的 readerIndex），原生 buf ，unwrappedIndex（buf 的 readerIndex），offset ， len （srcBuf 中的可读字节数）来初始化 Component 实例。

```java
private Component newComponent(final ByteBuf buf, final int offset) {
    // srcBuf 的 readerIndex = 1
    final int srcIndex = buf.readerIndex();
    // srcBuf 中的可读字节数 = 4
    final int len = buf.readableBytes();

    // srcBuf 可能是一个被包装过的 ByteBuf，比如 SlicedByteBuf，DuplicatedByteBuf
    // 获取 srcBuf 底层的原生 ByteBuf
    ByteBuf unwrapped = buf;
    // 原生 ByteBuf 的 readerIndex
    int unwrappedIndex = srcIndex;
    while (unwrapped instanceof WrappedByteBuf || unwrapped instanceof SwappedByteBuf) {
        unwrapped = unwrapped.unwrap();
    }

    // unwrap if already sliced
    if (unwrapped instanceof AbstractUnpooledSlicedByteBuf) {
        // 获取视图 ByteBuf  相对于 原生 ByteBuf 的相关 index 偏移
        // adjustment = 3
        // unwrappedIndex = srcIndex + adjustment = 4
        unwrappedIndex += ((AbstractUnpooledSlicedByteBuf) unwrapped).idx(0);
        // 获取原生 ByteBuf
        unwrapped = unwrapped.unwrap();
    } else if (unwrapped instanceof PooledSlicedByteBuf) {
        unwrappedIndex += ((PooledSlicedByteBuf) unwrapped).adjustment;
        unwrapped = unwrapped.unwrap();
    } else if (unwrapped instanceof DuplicatedByteBuf || unwrapped instanceof PooledDuplicatedByteBuf) {
        unwrapped = unwrapped.unwrap();
    }

    return new Component(buf.order(ByteOrder.BIG_ENDIAN), srcIndex,
            unwrapped.order(ByteOrder.BIG_ENDIAN), unwrappedIndex, offset, len, slice);
}
```

由于当前的 CompositeByteBuf 还是空的，里面没有包含任何逻辑数据，当长度为 4 的 srcBuf 加入之后，CompositeByteBuf 就产生了 `[0 , 3]` 这段逻辑数据范围，所以 srcBuf 所属 Component 的 offset = 0 , endOffset = 4 ，srcAdjustment = 1 ，adjustment = 4。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729763353720-088ad2a4-9a72-463e-8577-fb0f906f2113.webp)

。。。

## 3、Heap or Direct

在前面的几个小节中，我们讨论了很多 ByteBuf 的设计细节，接下来让我们**跳出**这些细节，重新站在全局的视角下来看一下 ByteBuf 的总体设计。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729763841723-d63737ab-5894-429f-863b-292ba039e0ce.webp)

在 ByteBuf 的整个设计体系中，Netty 从 ByteBuf 内存布局的角度上，将整个体系分为了 HeapByteBuf 和 DirectByteBuf 两个大类。Netty 提供了 `PlatformDependent.directBufferPreferred() `方法来指定在默认情况下，是否偏向于分配 Direct Memory。

```java
public final class PlatformDependent {
    // 是否偏向于分配 Direct Memory
    private static final boolean DIRECT_BUFFER_PREFERRED;

    public static boolean directBufferPreferred() {
        return DIRECT_BUFFER_PREFERRED;
    }
}
```

要想使得 DIRECT_BUFFER_PREFERRED 为 true ，必须同时满足以下两个条件：

- `-Dio.netty.noPreferDirect` 参数必须指定为 false（默认）。
- CLEANER 不为 NULL , 也就是需要 JDK 中包含有效的 CLEANER 机制。

```java
static {
    DIRECT_BUFFER_PREFERRED = CLEANER != NOOP
                              && !SystemPropertyUtil.getBoolean("io.netty.noPreferDirect", false);
    if (logger.isDebugEnabled()) {
        logger.debug("-Dio.netty.noPreferDirect: {}", !DIRECT_BUFFER_PREFERRED);
    }
}
```

如果是安卓平台，那么 CLEANER 直接就是 NOOP，不会做任何判断，默认情况下直接走 Heap Memory , 除非特殊指定要走 Direct Memory。

```java
if (!isAndroid()) {
    if (javaVersion() >= 9) {
        // 检查 sun.misc.Unsafe 类中是否包含有效的 invokeCleaner 方法
        CLEANER = CleanerJava9.isSupported() ? new CleanerJava9() : NOOP;
    } else {
        // 检查 java.nio.ByteBuffer 中是否包含了 cleaner 字段
        CLEANER = CleanerJava6.isSupported() ? new CleanerJava6() : NOOP;
    }
} else {
    CLEANER = NOOP;
}
```

如果是 JDK 9 以上的版本，Netty 会检查是否可以通过  `sun.misc.Unsafe` 的 `invokeCleaner` 方法正确执行 DirectBuffer 的 Cleaner，如果执行过程中发生异常，那么 CLEANER 就为 NOOP，Netty 在默认情况下就会走 Heap Memory。

```java
public final class Unsafe {
    public void invokeCleaner(java.nio.ByteBuffer directBuffer) {
        if (!directBuffer.isDirect())
            throw new IllegalArgumentException("buffer is non-direct");

        theInternalUnsafe.invokeCleaner(directBuffer);
    }
}
```

如果是 JDK 9 以下的版本，Netty 就会通过反射的方式先去获取 DirectByteBuffer 的 cleaner 字段，如果 cleaner 为 null 或者在执行 clean 方法的过程中出现了异常，那么 CLEANER 就为 NOOP，Netty 在默认情况下就会走 Heap Memory。

```java
class DirectByteBuffer extends MappedByteBuffer implements DirectBuffer
{
    private final Cleaner cleaner;

    DirectByteBuffer(int cap) {                   // package-private

        ...... 省略 .....   

        base = UNSAFE.allocateMemory(size);
        cleaner = Cleaner.create(this, new Deallocator(base, size, cap));
    }
}
```

如果 `PlatformDependent.directBufferPreferred()` 方法返回 true ,那么 ByteBufAllocator 接下来在分配内存的时候，默认情况下就会分配  directBuffer。

```java
public final class UnpooledByteBufAllocator  extends AbstractByteBufAllocator {
    // ByteBuf 分配器
    public static final UnpooledByteBufAllocator DEFAULT =
            new UnpooledByteBufAllocator(PlatformDependent.directBufferPreferred());
}

public abstract class AbstractByteBufAllocator implements ByteBufAllocator {
    // 是否默认分配 directBuffer
    private final boolean directByDefault;

    protected AbstractByteBufAllocator(boolean preferDirect) {
        directByDefault = preferDirect && PlatformDependent.hasUnsafe();
    }

    @Override
    public ByteBuf buffer() {
        if (directByDefault) {
            return directBuffer();
        }
        return heapBuffer();
    }
}
```

一般情况下，JDK 都会包含有效的 CLEANER 机制，所以我们完全可以仅是通过 `-Dio.netty.noPreferDirect` （默认 false）来控制 Netty 默认情况下走  Direct Memory。

但如果是安卓平台，那么无论  `-Dio.netty.noPreferDirect`  如何设置，Netty 默认情况下都会走  Heap Memory 。

## 4、Cleaner or NoCleaner

站在内存回收的角度，Netty 将 ByteBuf 分为了带有 Cleaner 的 DirectByteBuf 和没有 Cleaner 的 DirectByteBuf 两个大类。在之前的文章[《以 ZGC 为例，谈一谈 JVM 是如何实现 Reference 语义的》](https://mp.weixin.qq.com/s?__biz=Mzg2MzU3Mjc3Ng==&mid=2247489586&idx=1&sn=4306549c480f668458ab4df0d4b2ea47&scene=21#wechat_redirect) 中的第三小节，笔者详细的介绍过，JVM  如何利用 Cleaner 机制来回收 DirectByteBuffer 背后的 Native Memory 。

而 Cleaner 回收 DirectByteBuffer 的 Native Memory 需要依赖 GC 的发生，当一个 DirectByteBuffer 没有任何强引用或者软引用的时候，如果此时发生 GC , Cleaner 才会去回收 Native Memory。如果很久都没发生 GC ,那么这些 DirectByteBuffer 所引用的 Native Memory 将一直不会释放。

所以仅仅是依赖 Cleaner 来释放 Native Memory 是有一定延迟的，极端情况下，如果一直等不来 GC ,很有可能就会发生 OOM 。

而 Netty 的 ByteBuf 设计相当于是对 NIO ByteBuffer 的一种完善扩展，其底层其实都会依赖一个 JDK 的 ByteBuffer。比如，前面介绍的 UnpooledDirectByteBuf ， UnpooledUnsafeDirectByteBuf 其底层依赖的就是 JDK  DirectByteBuffer , 而这个 DirectByteBuffer 就是带有 Cleaner 的 ByteBuf 。
