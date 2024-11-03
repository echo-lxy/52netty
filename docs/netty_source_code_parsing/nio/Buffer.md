# Buffer 源码解析

## 前言

Netty 中的 `ByteBuf` 底层依赖于 JDK NIO 的 `ByteBuffer`。众所周知，JDK NIO 中的 `ByteBuffer` 设计复杂，相关 API 使用起来较为繁琐，易用性欠佳。因此，Netty 针对 JDK NIO 的 `ByteBuffer` 进行了优化，并重新设计出了一套简洁易用的 API。

基于上述思路，我们有必要学习 JDK NIO Buffer 的设计，为以后的 ByteBuf 教学打下坚实基础，分析 NIO `ByteBuffer` 的设计缺陷，以及 Netty 如何针对这些缺点进行优化。

## JDK NIO 中的 Buffer

在 NIO 出现之前，Java 传统的 IO 操作主要通过流的形式实现，包括网络 IO 和文件 IO。这一机制使用常见的输入流 `InputStream` 和输出流 `OutputStream`。

传统 IO 的 `InputStream` 和 `OutputStream` 的操作都是阻塞的。例如，当我们使用 `InputStream` 的 `read` 方法从流中读取数据时，如果流中没有数据，用户线程就必须阻塞等待。

此外，传统的输入输出流在处理字节流时一次只能处理一个字节。这导致在处理网络 IO 时，从 Socket 缓冲区读取数据的效率较低。而且，在操作字节流时只能线性处理流中的字节，无法来回移动字节流中的数据，从而在处理字节流时显得不够灵活。

综上所述，Java 传统 IO 是面向流的，流的处理是单向、阻塞的。无论是从输入流中读取数据，还是向输出流中写入数据，都是逐字节处理的。这种方式通常是边读取边处理数据，导致 IO 处理效率较低。

基于以上原因，JDK 1.4 引入了 NIO，NIO 是面向 Buffer 的。在进行 IO 操作时，NIO 会一次性将 Channel 中的数据读取到 Buffer 中，然后再进行后续处理。向 Channel 写入数据时同样需要一个 Buffer 做中转，批量写入 Channel。这样一来，我们可以利用 Buffer 在内部灵活移动字节数据，并根据所需的处理方式进行处理。

::: warning NIO Buffer 的最大优势

NIO Buffer 还提供了堆外的直接内存和内存映射相关的访问方式，从而避免了内存之间的多次拷贝。因此，即便传统 IO 中使用了 `BufferedInputStream`，也无法与 NIO Buffer 相媲美。

:::

## Buffer 的顶层抽象

JDK NIO 提供的 `Buffer` 本质上是一块内存，大家可以简单地将其想象为一个数组。JDK 将这块内存在语言层面**封装**成了 `Buffer` 的形式，使我们能够通过 `Buffer` 对这块内存进行数据的读取和写入，以及执行各种操作。

`Buffer` 类是 JDK NIO 定义的一个顶层抽象类，所有缓冲区的基本操作和基础属性均在此类中定义。在 Java 中，共有八种基本数据类型，JDK NIO 也为这八种类型分别提供了对应的 `Buffer` 类，可以将这类视为对应基本数据类型的数组。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031359195.png" alt="image-20241103135926073" style="zoom: 67%;" />

在解析具体的缓冲区实现之前，我们先来看看缓冲区的**顶层抽象类 Buffer 中定义了哪些抽象操作和属性，以及这些属性的用途**。这样可以帮助大家从整体上理解 JDK NIO 中 Buffer 的设计。

### Buffer 中的属性

```java
public abstract class Buffer {

    private int mark = -1;
    private int position = 0;
    private int limit;
    private int capacity;
    
             .............
}
```

首先，我们来介绍 `Buffer` 中最重要的三个属性。后续关于 `Buffer` 的各种操作都将依赖于这三个属性的动态变化。  

![image-20241103164939766](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031649868.png)

- **Capacity：** 这个属性很好理解，它规定了**整个 Buffer 的容量**，即具体可以容纳多少个元素。`capacity` 之前的元素均是 **Buffer** 可操作的空间。

- **Position**： 该属性用于**指向 Buffer 中下一个可操作的元素**，初始值为 0。在 **Buffer** 的写模式下，`position` 指针指向下一个可写位置；在读模式下，`position` 指针指向下一个可读位置。

- **Limit**： `limit` 表示 **Buffer** **可操作元素的上限**。在写模式下，可写元素的上限即为 **Buffer** 的整体容量，也就是 `capacity`。因此，`capacity - 1` 是 **Buffer** 最后一个可写位置。在读模式下，**Buffer** 中可读元素的上限是上一次写模式下最后一个写入元素的位置，也就是上一次写模式中的 `position`。

- **Mark**：`mark` 属性用于**标记 Buffer 当前 `position` 的位置**。这在对网络数据包进行解码时非常有用，特别是在使用 TCP 协议进行网络数据传输时，常常会遇到粘包和拆包的问题。为了解决这些问题，我们在解码之前需要调用 `mark` 方法，将 **Buffer** 的当前 `position` 指针保存到 `mark` 属性中。如果 **Buffer** 中的数据足够解码为一个完整的包，我们就执行解码操作。如果数据不够（即半包），我们会调用 `reset` 方法，将 `position` 还原到原来的位置，以等待剩余的网络数据到达。

![image-20241103165613838](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031656000.png)



### Buffer 中定义的核心抽象操作

本小节中介绍的这几个关于 Buffer 的核心操作均是基于上小节中介绍的那些核心 "指针" 的动态调整实现的。

#### 构造

构造 **Buffer** 的主要逻辑是根据用户指定的参数来初始化 **Buffer** 中的四个重要属性：`mark`、`position`、`limit` 和 `capacity`。它们之间的关系为：`mark ≤ position ≤ limit ≤ capacity`

- **mark**: 初始默认为 -1。
- **position**: 初始默认为 0。

这种关系确保了 **Buffer** 的操作安全性和有效性，为数据的读写提供了清晰的界限。

注意：limit指向的元素位置是不能读取和添加元素的。

![image-20241103165940756](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031659829.png)

```Java
public abstract class Buffer {

    private int mark = -1;
    private int position = 0;
    private int limit;
    private int capacity;

    Buffer(int mark, int pos, int lim, int cap) {     
        if (cap < 0)
            throw new IllegalArgumentException("Negative capacity: " + cap);
        this.capacity = cap;
        limit(lim);
        position(pos);
        if (mark >= 0) {
            if (mark > pos)
                throw new IllegalArgumentException("mark > position: ("
                                                   + mark + " > " + pos + ")");
            this.mark = mark;
        }
    }

    public final Buffer limit(int newLimit) {
        if ((newLimit > capacity) || (newLimit < 0))
            throw new IllegalArgumentException();
        limit = newLimit;
        if (position > limit) position = limit;
        if (mark > limit) mark = -1;
        return this;
    }

    public final Buffer position(int newPosition) {
        if ((newPosition > limit) || (newPosition < 0))
            throw new IllegalArgumentException();
        position = newPosition;
        if (mark > position) mark = -1;
        return this;
    }
}
```



#### 获取 Buffer 下一个可读取位置

在 **Buffer** 的读模式下，当我们需要从 **Buffer** 中读取数据时，首先要了解当前 **Buffer** 中 `position` 的位置。根据 `position` 的位置，我们可以读取 **Buffer** 中的元素。读取后，`position` 将向后移动指定的步长 `nb`。  

![image-20241103170229965](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031702101.png)

`nextGetIndex()` 方法首先获取 **Buffer** 当前 `position` 的位置，并将其作为 `readIndex` 返回给用户。随后，`position` 向后移动一位。在此方法中，步长 `nb` 默认为 1。  

```Java
final int nextGetIndex() {                        
    if (position >= limit)
        throw new BufferUnderflowException();
    return position++;
}

final int nextGetIndex(int nb) {          
    if (limit - position < nb)
        throw new BufferUnderflowException();
    int p = position;
    position += nb;
    return p;
}
```

> 如果我们从一个 **ByteBuffer** 中读取一个 **`int` 类型**的数据，在读取完成后，需要将 `position` 的位置向后移动 4 位。在这种情况下，`nextGetIndex(int nb)` 方法的步长 `nb` 应该指定为 4。这样可以确保 **Buffer** 的 `position` 正确地指向下一个可读取的元素。 

#### 获取 Buffer 下一个可写入位置

在 **Buffer** 的写模式下，向 **Buffer** 写入数据的过程与获取 `readIndex` 类似。首先，我们需要获取 **Buffer** 当前 `position` 的位置（`writeIndex`）。在写入元素后，`position` 将向后移动指定的步长 `nb`。

同样地，当我们向 **ByteBuffer** 中写入一个 `int` 类型的数据时，指定的步长 `nb` 也应为 4。这样可以确保 **Buffer** 的 `position` 正确地指向下一个可写入的位置。

```Java
final int nextPutIndex() {                        
    if (position >= limit)
        throw new BufferOverflowException();
    return position++;
}

final int nextPutIndex(int nb) {                  
    if (limit - position < nb)
        throw new BufferOverflowException();
    int p = position;
    position += nb;
    return p;
}
```

#### Buffer 读模式的切换

在 **Buffer** 的写模式下，当我们向 **Buffer** 写入数据后，接下来我们通常需要从 **Buffer** 中读取刚刚写入的数据。由于 NIO 在对 **Buffer** 的设计中，读写模式共用一个 `position` 属性，因此在进行读取之前，我们需要切换到读模式。

![image-20241103170419686](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031704832.png)

```Java
public final Buffer flip() {
    limit = position;
    position = 0;
    mark = -1;
    return this;
}
```

们看到 `flip()` 方法对 **Buffer** 中的四个指针进行了调整，以实现从写模式切换到读模式：

- **设置** `limit`：将当前的 `position`（下一个可写入的位置）作为读模式下的上限 `limit`。这意味着我们只能读取到上一次写入的结束位置。
- **重置** `position`：将 `position` 设置为 0，使我们可以从 **Buffer** 的起始位置开始读取之前写入的数据。

这种设计使得在同一 **Buffer** 中可以高效地切换读写模式，从而简化了数据的处理过程。

#### Buffer 写模式的切换

有读模式的切换，自然也就有对应的写模式切换。当我们在读模式下将 **Buffer** 中的数据读取完毕后，如果需要再次向 **Buffer** 写入数据，就必须切换回写模式。

![image-20241103170647878](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031706023.png)

```Java
public final Buffer clear() {
    position = 0;
    limit = capacity;
    mark = -1;
    return this;
}
```

我们看到调用 `clear()` 方法之后，**Buffer** 中各个指针的状态又回到了最初的状态：

- **position** 位置重新指向起始位置 0。
- **limit** 重新指向 **capacity** 的位置。

在这种状态下，向 **Buffer** 中写入数据时，将会从 **Buffer** 的开头处依次写入，新的数据会覆盖已经读取的部分数据。

这引发了一个问题：如果我们在读模式下只读取了 **Buffer** 中的数据的一部分，仍然有未读取的数据存在。当此时调用 `clear()` 方法开启写模式并向 **Buffer** 中写入数据时，就会意外地覆盖掉那些尚未读取的部分。这将导致数据丢失，从而引发错误或不一致的状态。

![image-20241103170951314](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031709470.png)

针对这种情况，我们不能简单地设置 **position** 指针，以免未读取的数据部分被覆盖。为了确保这些未读取数据不受影响，我们需要遵循以下步骤：

1. **移动未读取的数据**：首先，将 **Buffer** 中未读取的数据部分移动到最前面。这可以通过 `**compact()**` 方法实现，该方法将未读取的数据复制到 **Buffer** 的开头，从而腾出空间供新数据写入。
2. **调整** `**position**` **指针**：在完成未读取数据的移动后，更新 **position** 指针，使其指向可覆盖数据区域的第一个位置。此时，新数据的写入将从这个位置开始，避免覆盖掉未读取的数据。

通过这种方式，我们确保未读取的数据安全存储，同时在写入新数据时不会引发潜在的数据丢失问题。这样可以有效地管理 **Buffer** 的状态，提升数据处理的灵活性和安全性。

![image-20241103171036588](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031710729.png)

由于 **Buffer** 是顶层设计，主要负责定义相关操作规范，并未具体定义数据存储方式。因此，`**compact()**` 方法的实现被放置在具体的子类中。以下是 **HeapByteBuffer** 的实现示例：  

```Java
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

#### 重新读取 Buffer 中的数据 rewind

`rewind()` 方法用于重新读取 **Buffer** 中的数据。调用该方法后，`position` 的值会被重置为 0，使得可以从 **Buffer** 的开头开始重新读取数据。同时，`mark` 的值也会被丢弃。 

```Java
public final Buffer rewind() {
    position = 0;
    mark = -1;
    return this;
}
```

## NIO Buffer 背后的存储机制

针对每一种基本类型的 Buffer，NIO 根据其背后的数据存储方式进一步划分为三种类型：HeapBuffer、DirectBuffer 和 MappedBuffer。 

- HeapBuffer 顾名思义它背后的存储内存是在 JVM 堆中分配，在堆中分配一个数组用来存放 Buffer 中的数据 
- DirectBuffer 背后的存储内存是在堆外内存中分配
- MappedBuffer 是通过内存文件映射将文件中的内容直接映射到堆外内存中，其本质也是一个 DirectBuffer 。

由于 DirectBuffer 和 MappedBuffer 背后的存储内存是在堆外内存中分配，不受 JVM 管理，所以不能用一个 Java 基本类型的数组表示，而是直接记录这段堆外内存的起始地址。  

```Java
public abstract class ByteBuffer extends Buffer implements Comparable<ByteBuffer> {
    //在堆中使用一个数组存放Buffer数据
    final byte[] hb;  
}

public abstract class Buffer {
    //堆外内存地址
    long address;
}
```

综上所述，`HeapBuffer` 背后是有一个对应的基本类型数组作为存储的，而 `DirectBuffer` 和 `MappedBuffer` 背后则是一块堆外内存用于存储，并没有一个基本类型的数组。

`hasArray()` 方法就是用来判断一个 `Buffer` 背后是否有一个 Java 基本类型的数组做支撑。如果返回 `true`，则说明该 `Buffer` 是一个 `HeapBuffer`，并可以通过 `array()` 方法访问其内部数组；如果返回 `false`，则说明该 `Buffer` 是 `DirectBuffer` 或 `MappedBuffer`，不能通过数组直接访问。

```Java
public abstract boolean hasArray();	
```

如果 `hasArray()` 方法返回 `true`，我们就可以调用 `Object array()` 方法获取 `Buffer` 背后的支撑数组。通过这个支撑数组，我们可以直接访问和操作 `Buffer` 中的数据，从而提高操作的效率。 

```Java
public abstract Object array();
```

## Buffer 的视图

**Buffer 中还有一个不太好理解的属性是 offset，而这个 offset 到底是用来干什么的呢**？

```java
public abstract class ByteBuffer extends Buffer implements Comparable<ByteBuffer> {
    //在堆中使用一个数组存放Buffer数据
    final byte[] hb;  
    // 数组中的偏移，用于指定数组中的哪一段数据是被 Buffer 包装的
    final int offset;
}
```

事实上我们可以根据一段连续的内存地址或者一个数组创建出不同的 Buffer 视图出来。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729921394594-ac665b03-93d7-40d3-9fcf-36f4b27893e7.webp?x-oss-process=image%2Fresize%2Cw_937%2Climit_0)

**我们可以根据原生** `Buffer` **中的部分数据（例如图中的未处理数据部分）创建一个新的** `Buffer` **视图**。这个新的视图 `Buffer` 本质上也是一个 `Buffer`，拥有独立的 `mark`、`position`、`limit` 和 `capacity` 指针。这四个指针会在新的视图 `Buffer` 下重新被创建和赋值。因此，在新的视图 `Buffer` 下，操作与普通 `Buffer` 相同，也可以使用《2.2 Buffer 中定义的核心抽象操作》小节中介绍的那些方法，只不过操作的数据范围不同。

新的视图 `Buffer` 与原生 `Buffer` 共享一个存储数组或一段连续内存。从新的视图 `Buffer` 的角度来看，它的存储数组范围是 0 - 6，因此在此视图下，`position = 0`，`limit = capacity = 7`。这实际上是一个障眼法，真实情况是新的视图 `Buffer` 复用了原生 `Buffer` 中存储数组的 6 - 12 区域。

因此，在新视图 `Buffer` 中访问元素时，需要加上一个偏移量 `offset`，即 `position + offset`，才能正确访问到真实数组中的元素。在这里，`offset = 6`。

我们可以通过 `arrayOffset()` 方法获取视图 `Buffer` 中的 `offset`。

```java
public abstract int arrayOffset();
```

以上内容就是笔者要为大家介绍的 NIO `Buffer` 的顶层设计。接下来，我们将具体讨论 `Buffer` 下的实现类。

关于 `Buffer` 视图的创建和操作，笔者会将这部分内容放到具体的 `Buffer` 实现类中进行详细介绍。在这里，大家只需理解 `Buffer` 视图的概念即可~~~

## 抽象 Buffer 的具体实现类 ByteBuffer

通过前面的内容介绍，我们了解到 JDK NIO `Buffer` 为 Java 中每种基本类型都设计了对应的 `Buffer` 实现（除了 `boolean` 类型）。但在网络 I/O 处理中，使用频率最高的是 `ByteBuffer`

NIO 中的 `ByteBuffer` 根据其背后内存分配的区域不同，分为三种类型：`HeapByteBuffer`、`MappedByteBuffer` 和 `DirectByteBuffer`。

![image-20241103152903837](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031529906.png)

这三种类型的 `ByteBuffer` 具有一些通用的属性和方法，因此 `ByteBuffer` 这个类被设计成一个抽象类，用来封装这些通用的属性和方法，作为 `ByteBuffer` 这个基本类型 `Buffer` 的顶层规范。

```java
public abstract class ByteBuffer extends Buffer implements Comparable<ByteBuffer> {
    // Buffer背后的数组
    final byte[] hb;  
    // 数组 offset，用于创建 Buffer 视图                
    final int offset;
    // 标识 Buffer 是否是只读的
    boolean isReadOnly;                

    ByteBuffer(int mark, int pos, int lim, int cap,  
                 byte[] hb, int offset)
    {
        super(mark, pos, lim, cap);
        this.hb = hb;
        this.offset = offset;
    }

    ByteBuffer(int mark, int pos, int lim, int cap) { 
        this(mark, pos, lim, cap, null, 0);
    }

}
```

ByteBuffer 中除了之前介绍的 Buffer 类中定义的四种重要属性之外，又额外定义了三种属性；

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729921634233-bbfc88b8-7e0e-46f4-a52e-79f005350be8.webp?x-oss-process=image%2Fresize%2Cw_937%2Climit_0)

- `byte[] hb`：这是 `ByteBuffer` 中依赖的用于存储数据的数组。该字段只适用于 `HeapByteBuffer`，而 `DirectByteBuffer` 和 `MappedByteBuffer` 则依赖于堆外内存。堆外内存的起始地址存储于 `Buffer` 类中的 `address` 字段中。
- `int offset`：这是 `ByteBuffer` 中的内存偏移量，用于创建新的 `ByteBuffer` 视图。详细内容可回顾《4. Buffer 的视图》小节。
- `boolean isReadOnly`：用于标识该 `ByteBuffer` 是否为只读。

### 创建具体存储类型的 ByteBuffer

创建 `DirectByteBuffer`:

```java
public static ByteBuffer allocateDirect(int capacity) {
    return new DirectByteBuffer(capacity);
}
```

创建 `HeapByteBuffer`:

```java
public static ByteBuffer allocate(int capacity) {
    if (capacity < 0)
        throw new IllegalArgumentException();
    return new HeapByteBuffer(capacity, capacity);
}
```

由于 `MappedByteBuffer` 背后涉及的原理比较复杂（尽管 API 相对简单），笔者将在后面撰写一篇专门讲解 `MappedByteBuffer` 的文章。为了避免本文过于复杂，这里不再详细列出相关内容。

### 将字节数组映射成 ByteBuffer

经过前面的介绍，我们了解到 Buffer 实际上本质上就是一个数组，封装了一些对该数组的便利操作方法。既然 Buffer 已经为数组操作提供了便利，大家通常也不愿意直接操作原生字节数组。因此，将一个原生字节数组映射成一个 `ByteBuffer` 的需求应运而生。  

```java
public static ByteBuffer wrap(byte[] array, int offset, int length) {
    try {
        return new HeapByteBuffer(array, offset, length);
    } catch (IllegalArgumentException x) {
        throw new IndexOutOfBoundsException();
    }
}
```

`ByteBuffer` 中的 `wrap` 方法提供了将字节数组映射成 `ByteBuffer` 的实现。该方法可以将字节数组全部映射为一个 `ByteBuffer`，或者灵活地将字节数组中的部分字节数据映射为一个 `ByteBuffer`。

- `byte[] array`：需要映射成 `ByteBuffer` 的原生字节数组。
- `int offset`：用于指定映射后 Buffer 的 `position`，即 `position = offset`。注意，此处的 `offset` 并不是 Buffer 视图中的 `offset`。
- `int length`：用于计算映射后 Buffer 的 `limit`，即 `limit = offset + length`，`capacity = array.length`。

映射后的 ByteBuffer 中 Mark = -1，offset = 0。此处的 offset 才是 Buffer 视图中的 offset。

```Java
HeapByteBuffer(byte[] buf, int off, int len) { // package-private
    super(-1, off, off + len, buf.length, buf, 0);
}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729921896635-4eb32a31-f32e-4349-8858-ab21a47f37bd.webp?x-oss-process=image%2Fresize%2Cw_937%2Climit_0)

以上介绍的 `wrap` 映射方法是根据用户自定义的 `position` 和 `limit` 对原生字节数组进行灵活映射。当然，NIO 中还提供了一个方法，可以直接对原生字节数组 `array` 进行默认的全部映射。映射后的 Buffer 为：

- `position = 0`
- `limit = capacity = array.length`

```Java
public static ByteBuffer wrap(byte[] array) {
    return wrap(array, 0, array.length);
}
```

### 定义 ByteBuffer 视图相关操作

前面《4. Buffer 的视图》小节的介绍中，笔者提到顶层抽象类 `Buffer` 中定义的 `offset` 属性，这个属性用于创建 Buffer 视图。在该小节中，笔者已详细介绍了 Buffer 创建视图的相关原理和过程。而视图创建的相关操作则定义在 `ByteBuffer` 这个抽象类中，主要包括 `slice()` 方法和 `duplicate()` 方法。

在这里，笔者再次强调，基于原生 `ByteBuffer` 创建的新 `ByteBuffer` 视图实际上是 NIO 设计的一个障眼法。原生的 `ByteBuffer` 和它的视图 `ByteBuffer` 本质上是共用同一块内存。对于 `HeapByteBuffer` 来说，这块共用的内存就是 JVM 堆上的一个字节数组；而对于 `DirectByteBuffer` 和 `MappedByteBuffer` 来说，这块共用的内存则是堆外内存中的同一块区域。

`ByteBuffer` 的视图本质上也是一个 `ByteBuffer`，原生的 `ByteBuffer` 和它的视图 `ByteBuffer` 拥有各自独立的 `mark`、`position`、`limit` 和 `capacity` 指针。然而，它们背后依赖的内存空间是相同的。因此，在视图 `ByteBuffer` 上进行的任何操作，原生 `ByteBuffer` 都是可以感知的；同样，在原生 `ByteBuffer` 上进行的任何操作，视图 `ByteBuffer` 也能感知。它们是相互影响的，这一点需要特别注意。

#### slice()

```java
public abstract ByteBuffer slice();
```

调用 `slice()` 方法创建出来的  ByteBuffer 视图内容是从原生 ByteBufer 的当前位置 position 开始一直到 limit 之间的数据。也就是说通过 slice() 方法创建出来的视图里边的数据是原生 ByteBuffer 中还未处理的数据部分。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729932904944-a0fbf46f-513c-4f23-a534-dddd19094529.webp)



如上图所属，调用 slice() 方法创建出来的视图 ByteBuffer  它的存储数组范围：0 - 6，所以再此视图下 position = 0，limit = capacity = 7。这其实是一个障眼法，真实情况是新的视图 ByteBuffer 其实是复用原生 ByteBuffer 中的存储数组中的 6 - 12 这块区域（未处理的数据部分）。

所以在视图 ByteBuffer 中访问元素的时候，就需要 position + offset 来访问才能正确的访问到真实数组中的元素。这里的 offset = 6。

下面是 HeapByteBuffer 中关于 slice() 方法的具体实现：

```java
class HeapByteBuffer extends ByteBuffer {

    public ByteBuffer slice() {
        return new HeapByteBuffer(
            hb,
            -1,
            0,
            this.remaining(),
            this.remaining(),
            this.position() + offset);
    }

}
```

#### duplicate()

 由 `duplicate()` 方法创建的视图相当于完全复刻了原生 `ByteBuffer`。它们的 `offset`、`mark`、`position`、`limit` 和 `capacity` 变量的值都是相同的。然而，值得注意的是，尽管这些值相同，它们之间是相互独立的，允许对同一字节数组进行不同的逻辑处理。  

```java
public abstract ByteBuffer duplicate();
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729933006886-1c52e185-4cc6-4255-af89-26b35bb5708a.webp?x-oss-process=image%2Fresize%2Cw_937%2Climit_0)

下面是 HeapByteBuffer 中关于 `duplicate()` 方法的具体实现：

```java
class HeapByteBuffer extends ByteBuffer {

    public ByteBuffer duplicate() {
        return new HeapByteBuffer(
            hb,
            this.markValue(),
            this.position(),
            this.limit(),
            this.capacity(),
            offset);
    }

}
```

#### asReadOnlyBuffer()

通过 `asReadOnlyBuffer()` 方法，我们可以基于原生 `ByteBuffer` 创建出一个只读视图。对于只读视图的 `ByteBuffer`，只能进行读取操作，无法写入。尝试对只读视图进行写入操作将会抛出 `ReadOnlyBufferException` 异常。

以下是 `HeapByteBuffer` 中关于 `asReadOnlyBuffer()` 方法的具体实现：

```Java
class HeapByteBuffer extends ByteBuffer {

   public ByteBuffer asReadOnlyBuffer() {

        return new HeapByteBufferR(hb,
                                     this.markValue(),
                                     this.position(),
                                     this.limit(),
                                     this.capacity(),
                                     offset);
    }

}
```

在 NIO 中，专门设计了一个只读 `ByteBuffer` 视图类，其 `isReadOnly` 属性被设置为 `true`。这个类确保了视图中的数据只能被读取，任何写入操作都会被禁止，从而提供了对数据的保护。

```java
class HeapByteBufferR extends HeapByteBuffer {

   protected HeapByteBufferR(byte[] buf,
                                   int mark, int pos, int lim, int cap,
                                   int off)
    {
        super(buf, mark, pos, lim, cap, off);
        this.isReadOnly = true;

    }

}
```

### 定义 ByteBuffer 读写相关操作

`ByteBuffer` 中定义了四种针对 Buffer 读写的基本操作方法。由于 `ByteBuffer` 这个抽象类是一个顶层设计类，它只是规范性地定义了针对 `ByteBuffer` 操作的基本行为，并不负责具体数据的存储。因此，这四种基本操作方法将会在其具体的实现类中实现，我们后面会逐一介绍。这里主要向大家展示 NIO 针对 `ByteBuffer` 的顶层设计。 

```Java
//从ByteBuffer中读取一个字节的数据，随后position的位置向后移动一位
public abstract byte get();

//向ByteBuffer中写入一个字节的数据，随后position的位置向后移动一位
public abstract ByteBuffer put(byte b);

//按照指定index从ByteBuffer中读取一个字节的数据，position的位置保持不变
public abstract byte get(int index);

//按照指定index向ByteBuffer中写入一个字节的数据，position的位置保持不变
public abstract ByteBuffer put(int index, byte b);
```

在 `ByteBuffer` 类中，除了定义了这四种基本的读写操作外，还基于这四个基本操作衍生出了几种通用操作。下面笔者将为大家介绍这几种通用的操作：  

```java
//将 ByteBuffer中的字节转移到指定的字节数组 dst 中
public ByteBuffer get(byte[] dst, int offset, int length) {
     //检查指定index的边界，确保不能越界
    checkBounds(offset, length, dst.length);
    //检查ByteBuffer是否有足够的转移字节
    if (length > remaining())
        throw new BufferUnderflowException();
    int end = offset + length;
    // 从当前ByteBuffer中position开始转移length个字节 到dst数组中
    for (int i = offset; i < end; i++)
        dst[i] = get();
    return this;
}

//将指定字节数组 src 中的数据转移到 ByteBuffer中
public ByteBuffer put(byte[] src, int offset, int length) {
    //检查指定index的边界，确保不能越界
    checkBounds(offset, length, src.length);
    //检查ByteBuffer是否能够容纳得下
    if (length > remaining())
        throw new BufferOverflowException();
    int end = offset + length;
    //从字节数组的offset处，转移length个字节到ByteBuffer中
    for (int i = offset; i < end; i++)
        this.put(src[i]);
    return this;
}
```

在为大家介绍完 `ByteBuffer` 的抽象设计之后，笔者相信大家对 NIO 的 `ByteBuffer` 已经有了一个整体的认识。

接下来的内容，笔者将详细介绍之前多次提到的这三种 `ByteBuffer` 的具体实现类型：

![image-20241103154344110](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031543161.png)

## Direct vs. non-direct buffers

字节缓冲区可以是直接的或非直接的。对于一个直接字节缓冲区，Java虚拟机会尽力直接对其执行本机I/O操作。也就是说，它会尝试在每次调用底层操作系统的本机I/O操作之前（或之后）避免将缓冲区的内容复制到（或从）一个中间缓冲区。

可以通过调用此类的 `allocateDirect` 工厂方法来创建直接字节缓冲区。通过此方法返回的缓冲区通常具有比非直接缓冲区更高的分配和释放成本。直接缓冲区的内容可能位于正常的垃圾回收堆之外，因此它们对应用程序内存占用的影响可能不明显。因此，建议主要为大型、长期存在且需要底层系统本机I/O操作的缓冲区分配直接缓冲区。一般来说，只有在直接缓冲区能够带来可测量的程序性能提升时，才最好进行分配。

直接字节缓冲区还可以通过将文件的某个区域直接映射到内存中来创建。Java平台的实现可以选择通过JNI支持从本机代码创建直接字节缓冲区。如果这些缓冲区的实例引用了一个不可访问的内存区域，则尝试访问该区域将不会改变缓冲区的内容，并且将在访问时或稍后某个时间抛出未定义的异常。

通过调用其 `isDirect` 方法，可以确定字节缓冲区是直接的还是非直接的。此方法提供的功能可以在性能关键的代码中进行显式的缓冲区管理。

 让我们从 `HeapByteBuffer` 开始。`HeapByteBuffer` 的相关实现是最简单且最容易理解的。在 `HeapByteBuffer` 的介绍中，我们将详细讲解 Buffer 操作的实现。理解了 `HeapByteBuffer` 的相关实现后，其他的 Buffer 实现类也会变得更加容易理解，因为它们大同小异。  

![image-20241103171142934](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031711988.png)

HeapByteBuffer 的底层就是直接使用的此 `hb`数组，

## HeapByteBuffer 的相关实现

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729933370162-a5247038-9d19-45be-a224-50a237363858.webp?x-oss-process=image%2Fresize%2Cw_937%2Climit_0)

经过前面几个小节的介绍，大家应该对 `HeapByteBuffer` 的结构有了清晰的了解。`HeapByteBuffer` 主要依赖于 JVM 堆中的一个字节数组 `byte[] hb`。

在这个 JVM 堆中的字节数组的基础上，实现了在 `Buffer` 类和 `ByteBuffer` 类中定义的抽象方法。

### HeapByteBuffer 的构造

在 `HeapByteBuffer` 的构造过程中，首先会根据用户指定的 Buffer 容量 `cap` 在 JVM 堆中创建一个容量为 `cap` 的字节数组，作为 `HeapByteBuffer` 底层存储数据的容器。  

```Java
class HeapByteBuffer extends ByteBuffer {

   HeapByteBuffer(int cap, int lim) {      
        super(-1, 0, lim, cap, new byte[cap], 0);
   }

}

public abstract class ByteBuffer extends Buffer implements Comparable<ByteBuffer> {

    ByteBuffer(int mark, int pos, int lim, int cap,   
                 byte[] hb, int offset)
    {
        super(mark, pos, lim, cap);
        this.hb = hb;
        this.offset = offset;
    }

}
```

 此外，我们在《5.2 将字节数组映射成 ByteBuffer》小节中介绍过的，用于将原生字节数组映射成 `ByteBuffer` 的 `wrap` 方法中用到的构造函数：  

```java
public static ByteBuffer wrap(byte[] array, int offset, int length) {
    try {
        return new HeapByteBuffer(array, offset, length);
    } catch (IllegalArgumentException x) {
        throw new IndexOutOfBoundsException();
    }
}
HeapByteBuffer(byte[] buf, int off, int len) { 
    super(-1, off, off + len, buf.length, buf, 0);
}
```

同时，在《5.3 定义 ByteBuffer 视图相关操作》小节中介绍的用于创建 `ByteBuffer` 视图的两个方法 `slice()` 和 `duplicate()` 中也使用了相应的构造函数： 

```Java
protected HeapByteBuffer(byte[] buf,
                               int mark, int pos, int lim, int cap,
                               int off)
{
    super(mark, pos, lim, cap, buf, off);
}
```

### 读取&写入

```java
public byte get(int i) {
    return hb[ix(checkIndex(i))];
}

public ByteBuffer get(byte[] dst, int offset, int length) {
    checkBounds(offset, length, dst.length);
    if (length > remaining())
        throw new BufferUnderflowException();
    System.arraycopy(hb, ix(position()), dst, offset, length);
    position(position() + length);
    return this;
}

public ByteBuffer put(byte x) {
    hb[ix(nextPutIndex())] = x;
    return this;
}

protected int ix(int i) {
    return i + offset;
}

public ByteBuffer put(int i, byte x) {
    hb[ix(checkIndex(i))] = x;
    return this;
}

public ByteBuffer put(byte[] src, int offset, int length) {

    checkBounds(offset, length, src.length);
    if (length > remaining())
        throw new BufferOverflowException();
    System.arraycopy(src, offset, hb, ix(position()), length);
    position(position() + length);
    return this;
}
```

## 向 HeapByteBuffer 中写入指定基本类型

 HeapByteBuffer 背后是一个在 JVM 堆中开辟的字节数组，里面存放的是一个个的字节。当我们以单个字节的形式操作 HeapByteBuffer 时，并没有什么问题。然而，当我们向 HeapByteBuffer 写入指定的基本类型数据时，比如写入一个 `int` 型（占用 4 个字节）或写入一个 `double` 型（占用 8 个字节），就必须考虑字节序的问题了。  

```java
public abstract class ByteBuffer extends Buffer implements Comparable<ByteBuffer> {

   boolean bigEndian = true;
   boolean nativeByteOrder = (Bits.byteOrder() == ByteOrder.BIG_ENDIAN);

}
```

我们可以强制网络协议传输使用大端字节序，但无法强制主机采用特定的字节序。因此，在网络 I/O 场景下，我们经常需要进行字节序的转换工作。

JDK NIO 的 `ByteBuffer` 默认采用大端模式。我们可以通过 NIO 提供的操作类 `Bits` 获取主机字节序，使用 `Bits.byteOrder()` 方法，或者直接获取 `ByteBuffer` 中的 `nativeByteOrder` 字段来判断主机的字节序：`true` 表示主机字节序为大端模式，`false` 表示主机字节序为小端模式。

当然，我们也可以通过 `ByteBuffer` 中的 `order` 方法来指定我们想要的字节序：

```java
public final ByteBuffer order(ByteOrder bo) {
    bigEndian = (bo == ByteOrder.BIG_ENDIAN);
    nativeByteOrder =
        (bigEndian == (Bits.byteOrder() == ByteOrder.BIG_ENDIAN));
    return this;
}
```

 下面，笔者将带大家分别从大端模式和小端模式下，看看如何向 HeapByteBuffer 写入一个指定的基本类型数据。我们以 `int` 型数据为例，假设要写入的 `int` 值为 5674。  

### 字节序

【TODO】

### 大端字节序

```java
class HeapByteBuffer extends ByteBuffer {

    public ByteBuffer putInt(int x) {
        Bits.putInt(this, ix(nextPutIndex(4)), x, bigEndian);
        return this;
    }
}
```

首先，我们需要获取当前 HeapByteBuffer 的写入位置 `position`。由于我们要写入的是一个 `int` 型的数据，所以在写入完毕后，`position` 的位置需要向后移动 4 位。`nextPutIndex` 方法的逻辑笔者在之前的内容中已经详细介绍过，这里不再赘述。  

```java
class Bits { 

    static void putInt(ByteBuffer bb, int bi, int x, boolean bigEndian) {
        if (bigEndian)
            // 采用大端字节序写入 int 数据
            putIntB(bb, bi, x);
        else
            // 采用小端字节序写入 int 数据
            putIntL(bb, bi, x);
    }

    static void putIntB(ByteBuffer bb, int bi, int x) {
        bb._put(bi    , int3(x));
        bb._put(bi + 1, int2(x));
        bb._put(bi + 2, int1(x));
        bb._put(bi + 3, int0(x));
    }
}
```

大家看到了吗？这里按照我们之前介绍的大端字节序，从 `int` 值 5674 的二进制高位字节到低位字节依次写入 HeapByteBuffer 的字节数组的低地址中。

这里的 `int3(x)` 方法负责获取写入数据 `x` 的最高位字节，并将该字节（下图中绿色部分）写入字节数组中的低地址中（下图中对应绿色部分）。

同理，`int2(x)`、`int1(x)` 和 `int0(x)` 方法依次获取 `x` 的次高位字节，并依次写入字节数组中的低地址中。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729934578136-6ea028b2-0595-4a2f-9125-a617975cfb99.webp)

那么我们如何依次获得一个 int 型数据的高位字节呢？大家接着跟着笔者往下走~

#### int3(x) 获取 int 型最高位字节

```java
class Bits { 

     private static byte int3(int x) { return (byte)(x >> 24); }

}
```

#### int2(x) 获取 int 型次高位字节

```java
class Bits { 

 private static byte int2(int x) { return (byte)(x >> 16); }

}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729934637674-cf41a067-8d82-4433-9112-b222982ce49a.webp)

#### int1(x) 获取 int 型第三高位字节

```java
class Bits { 

 private static byte int1(int x) { return (byte)(x >> 8); }

}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729934680420-57576c32-33fa-4e32-aaea-2ad587493891.webp)

#### int0(x) 获取 int 型最低位字节

```java
class Bits { 

 private static byte int0(int x) { return (byte)(x      ); }

}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729934699015-ba608f5f-2271-4226-8014-122971ab0814.webp)

最终 int 型变量 5764 按照大端字节序写入到 HeapByteBuffer之后的字节数组结构如下：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729934735421-227e6299-6267-451a-92ed-85dc2d32dfca.webp)

### 小端字节序

在我们彻底理解了大端字节序的操作之后，小端字节序的相关操作就很好理解了。

```java
static void putIntL(ByteBuffer bb, int bi, int x) {
    bb._put(bi + 3, int3(x));
    bb._put(bi + 2, int2(x));
    bb._put(bi + 1, int1(x));
    bb._put(bi    , int0(x));
}
```

根据我们之前介绍的小端字节序的定义，在小端模式下二进制数据的高位是存储在字节数组中的高地址中，二进制数据的低位是存储在字节数组中的低地址中。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729934765327-cbd7ff91-cc5e-42ad-abb6-4aacf1981fcb.webp)

## 从 HeapByteBuffer 中读取指定基本类型

了解了在不同字节序下向 HeapByteBuffer 中写入指定基本类型数据的过程后，读取指定基本类型数据的过程也就更容易理解了。

我们仍以 `int` 型数据为例，假设需要从 HeapByteBuffer 中读取一个 `int` 值。

首先，我们获取当前 HeapByteBuffer 的读取位置 `position`，从 `position` 位置开始读取四个字节，然后通过这四个字节组装成一个 `int` 值并返回。

```java
class HeapByteBuffer extends ByteBuffer {

    public int getInt() {
        return Bits.getInt(this, ix(nextGetIndex(4)), bigEndian);
    }

}
class Bits { 

  static int getInt(ByteBuffer bb, int bi, boolean bigEndian) {
        return bigEndian ? getIntB(bb, bi) : getIntL(bb, bi) ;
    }

}
```

我们还是先来介绍大端模式下的读取过程：

### 大端字节序

```java
class Bits { 

    static int getIntB(ByteBuffer bb, int bi) {
        return makeInt(bb._get(bi    ),
                       bb._get(bi + 1),
                       bb._get(bi + 2),
                       bb._get(bi + 3));
    }

}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729935060948-1890f3c8-3e71-483e-9480-74b73230dfdb.webp)

由于在大端模式下，二进制数据的高位是存放于字节数组中的低地址中，我们需要从字节数组中的低地址中依次读取二进制数据的高位出来。

然后我们从高位开始依次组装 int 型数据，正好和写入过程相反。

```java
static private int makeInt(byte b3, byte b2, byte b1, byte b0) {
    return (((b3       ) << 24) |
            ((b2 & 0xff) << 16) |
            ((b1 & 0xff) <<  8) |
            ((b0 & 0xff)      ));
}
```

### 小端字节序

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729935092468-a66047b1-327d-4ceb-b825-954ac586990f.webp)

```java
class Bits { 

    static int getIntL(ByteBuffer bb, int bi) {
        return makeInt(bb._get(bi + 3),
                       bb._get(bi + 2),
                       bb._get(bi + 1),
                       bb._get(bi    ));
    }

}
```

而在小端模式下，我们则需要先从字节数组中的高地址中将二进制数据的高位依次读取出来，然后在从高位开始依次组装 int 型数据。

在笔者介绍完了关于 int 数据的读写过程之后，相信大家可以很轻松的理解其他基本类型在不同字节序下的读写操作过程了。

## 将 HeapByteBuffer 转换成指定基本类型的 Buffer

在《2. NIO 对 Buffer 的顶层抽象》小节一开始就介绍到，NIO 其实为我们提供了多种基本类型的 Buffer 实现。

NIO 允许我们将 ByteBuffer 转换成任意一种基本类型的 Buffer，这里我们以转换 IntBuffer 为例说明：

```java
class HeapByteBuffer extends ByteBuffer {

    public IntBuffer asIntBuffer() {
        int size = this.remaining() >> 2;
        int off = offset + position();
        return (bigEndian
                ? (IntBuffer)(new ByteBufferAsIntBufferB(this,
                                                             -1,
                                                             0,
                                                             size,
                                                             size,
                                                             off))
                : (IntBuffer)(new ByteBufferAsIntBufferL(this,
                                                             -1,
                                                             0,
                                                             size,
                                                             size,
                                                             off)));
    }

}
```

IntBuffer 底层其实依托了一个 ByteBuffer，当我们向 IntBuffer 读取一个 int 数据时，其实是从底层依托的这个 ByteBuffer 中读取 4 个字节出来然后组装成 int 数据返回。

```java
class ByteBufferAsIntBufferB extends IntBuffer {

    protected final ByteBuffer bb;

    public int get() {
        return Bits.getIntB(bb, ix(nextGetIndex()));
    }
}
class Bits { 

    static int getIntB(ByteBuffer bb, int bi) {
        return makeInt(bb._get(bi    ),
                       bb._get(bi + 1),
                       bb._get(bi + 2),
                       bb._get(bi + 3));
    }

    static private int makeInt(byte b3, byte b2, byte b1, byte b0) {
        return (((b3       ) << 24) |
                ((b2 & 0xff) << 16) |
                ((b1 & 0xff) <<  8) |
                ((b0 & 0xff)      ));
    }

}
```

同样地，当我们向 IntBuffer 中写入一个 `int` 数据时，实际上是向它依托的底层 ByteBuffer 写入了 4 个字节。

IntBuffer 底层依赖的这个 ByteBuffer，根据字节序的不同，会采用不同的实现：`ByteBufferAsIntBufferB`（大端实现）和 `ByteBufferAsIntBufferL`（小端实现）。

鉴于前面已经详细介绍了 HeapByteBuffer 的实现，`ByteBufferAsIntBufferB` 和 `ByteBufferAsIntBufferL` 的操作过程基本相同，这里就不再赘述。如果感兴趣，可以自行查看相关实现，理解它们在不同字节序下的具体操作细节。

## 总结

在本文中，我们围绕 JDK NIO 中最简单的实现类 `HeapByteBuffer` 为主线，从 NIO 对 Buffer 的顶层抽象设计出发，整体上讲解了 Buffer 的设计架构。

在探讨过程中，我们可以发现 NIO 对 Buffer 的设计是相对复杂的，尤其在裸用 NIO 编程时会遇到许多反直觉的操作，稍有不慎就可能引发错误。例如，`Buffer` 模式的切换操作：用于读模式的 `flip()` 方法、写模式的 `clear()` 和 `compact()` 方法、以及重新处理 `Buffer` 中数据的 `rewind()` 方法。这些方法要求在使用过程中始终保持对 Buffer 内部数据分布的清晰理解，否则容易导致数据覆盖或丢失。

接着，我们讨论了 `Buffer` 的视图概念及操作，特别是 `slice()` 和 `duplicate()` 方法，以及视图 Buffer 与原生 Buffer 之间的差异与联系。

在讲解 `HeapByteBuffer` 的示例时，我们还深入解析了 NIO Buffer 顶层抽象方法的实现，并基于此详细分析了在不同字节序下 `ByteBuffer` 的读写操作。随之介绍了 `ByteBuffer` 与基本类型（如 `IntBuffer`、`LongBuffer`）之间的转换，帮助理解字节序对 Buffer 操作的影响。

由于 `HeapByteBuffer` 足够简单，通过它可以将 NIO Buffer 的设计与实现串联起来。不过，根据底层存储机制不同，NIO 中还提供了 `DirectByteBuffer` 和 `MappedByteBuffer`，虽然它们的 API 和 `HeapByteBuffer` 基本一致，但背后的实现原理（特别是 `MappedByteBuffer`）非常复杂。

因此，在后续的文章中，我将分别深入讲解 `DirectByteBuffer` 和 `MappedByteBuffer` 的内部原理，帮助大家不仅熟悉使用这些 Buffer，还能彻底理解其复杂的实现逻辑，达到“知其然，更知其所以然”的目的。

## 参考

* [一步一图带你深入剖析 JDK NIO ByteBuffer 在不同字节序下的设计与实现 - bin的技术小屋 - 博客园](https://www.cnblogs.com/binlovetech/p/16575557.html)