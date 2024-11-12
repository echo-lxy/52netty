# DirectByteBuffer & MappedByteBuffer 源码分析

## 前言

请在阅读本文之前，务必先阅读[《Buffer 源码解析》](/netty_source_code_parsing/nio/Buffer)。

对于 `ByteBuffer` 而言，有两个较为特殊的类：`DirectByteBuffer` 和 `MappedByteBuffer`，这两个类的原理都是基于内存文件映射的。

`ByteBuffer` 分为两种，一种是直接的，另一种是间接的。

- **直接缓冲**：直接使用内存映射，对于 Java 而言，就是直接在 JVM 之外分配虚拟内存地址空间，Java 中使用 `DirectByteBuffer` 来实现，也就是堆外内存。
- **间接缓冲**：是在 JVM 堆上实现，Java 中使用 `HeapByteBuffer` 来实现，也就是堆内内存。

我们这篇文章主要分析直接缓冲，即 `DirectByteBuffer`。在了解 `DirectByteBuffer` 之前，我们需要先了解操作系统的内存管理方面的知识点。

## 内存映射

下图是 Linux 进程的虚拟内存结构：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031805181.png" alt="image-20241103180547102" style="zoom:67%;" />

注意其中一块区域“Memory mapped region for shared libraries”。这块区域是在内存映射文件时，将某一段的虚拟地址和文件对象的某一部分建立映射关系。此时，并没有拷贝数据到内存中，而是当进程代码第一次引用这段代码内的虚拟地址时，触发缺页异常。此时，操作系统根据映射关系，直接将文件的相关部分数据拷贝到进程的用户私有空间中去。当有操作第 N 页数据时，重复这样的操作，执行 OS 页面调度程序。

这种方式**减少了文件从内核空间到用户空间的拷贝**，效率比标准 IO 高。下面两张图片展示了标准 IO 操作和内存映射文件的对比，小伙伴们可以认真对比一下（图片来自：[blog.csdn.net/linxdcn/art…](https://link.juejin.cn?target=https%3A%2F%2Fblog.csdn.net%2Flinxdcn%2Farticle%2Fdetails%2F72903422)）。

- **标准 IO**

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031805299.png" alt="image-20241103180559189" style="zoom:67%;" />

- **内存文件映射**

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031806251.png" alt="image-20241103180613127" style="zoom:67%;" />





## 直接内存

直接内存是一种特殊的内存缓冲区，并不在 Java 堆或方法区中分配，而是通过 JNI 的方式在本地内存上分配。

::: tip JNI 是什么 

**JNI**（Java Native Interface）是 Java 本地方法接口，它允许 Java 代码与 C、C++ 代码交互的标准机制。维基百科这样解释：“当应用无法完全用 Java 编程语言实现时（例如，标准 Java 类库不支持的特定平台特性或程序库），JNI 使得编程者能够编写 native 方法来处理这种情况”。这意味着，在一个 Java 应用程序中，我们可以使用所需的 C++ 类库，并直接与 Java 代码交互，甚至在 C++ 程序内反过来调用 Java 方法（回调函数）。 

:::

直接内存并不是虚拟机运行时数据区的一部分，也不是虚拟机规范中定义的内存区域，但这部分内存被频繁使用，并且可能会导致 `OutOfMemoryError` 错误的出现。

**JDK1.4 中新加入的 NIO（Non-Blocking I/O，也被称为 New I/O），引入了一种基于 通道（Channel）与 缓存区（Buffer）的 I/O 方式。它可以直接使用 Native 函数库分配堆外内存，然后通过存储在 Java 堆中的 `DirectByteBuffer` 对象来引用并操作这块内存。这样可以在一些场景中显著提高性能，因为避免了在 Java 堆和 Native 堆之间来回复制数据。**

直接内存的分配不会受到 Java 堆的限制，但仍会受到本机总内存大小以及处理器寻址空间的限制。

类似的概念还有 **堆外内存**。在一些文章中，直接内存与堆外内存等价，但个人认为这并不完全准确。

堆外内存指的是将内存对象分配到堆外，这些内存直接由操作系统管理，而非虚拟机。这样做的结果是可以在一定程度上减少垃圾回收对应用程序的影响。

## MappedByteBuffer

先看 `MappedByteBuffer` 和 `DirectByteBuffer` 的类图：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031806038.png" alt="image-20241103180643982" style="zoom:67%;" />

`MappedByteBuffer` 是一个抽象类，`DirectByteBuffer` 则是它的子类。

作为抽象类，`MappedByteBuffer` 本身其实非常简单，定义如下：

```java
public abstract class MappedByteBuffer extends ByteBuffer {

    // 文件描述符
    private final FileDescriptor fd;

    // package 访问级别
    // 只能通过子类 DirectByteBuffer 构造函数调用
    MappedByteBuffer(int mark, int pos, int lim, int cap, FileDescriptor fd) {
        super(mark, pos, lim, cap);
        this.fd = fd;
    }

    MappedByteBuffer(int mark, int pos, int lim, int cap) {
        super(mark, pos, lim, cap);
        this.fd = null;
    }

    // 省略一些代码
}
```

其实在父类 `Buffer` 中有一个非常重要的属性 `address`

```Java
// Used only by direct buffers
// NOTE: hoisted here for speed in JNI GetDirectBufferAddress
long address;
```

这个属性表示分配堆外内存的地址，目的是为了在 JNI 调用 `GetDirectBufferAddress` 时提升调用的速率。这个属性我们在后面会经常用到，到时候再做详细分析。

`MappedByteBuffer` 作为抽象类，我们可以通过调用 `FileChannel` 的 `map()` 方法来创建，代码如下：

```Java
FileInputStream inputStream = new FileInputStream("/Users/echo/Downloads/test.txt");
FileChannel fileChannel = inputStream.getChannel();
MappedByteBuffer mappedByteBuffer = fileChannel.map(FileChannel.MapMode.READ_ONLY, 0,fileChannel.size());
```

`map()` 方法签名如下：

```Java
public abstract MappedByteBuffer map(MapMode mode, long position, long size)
    throws IOException;
```

该方法可以将文件从 `position` 开始的 `size` 大小的区域映射为 `MappedByteBuffer`，`mode` 定义了可访问该内存映射文件的访问方式，共有三种：

- `MapMode.READ_ONLY`（只读）：试图修改得到的缓冲区将导致抛出 `ReadOnlyBufferException`。
- `MapMode.READ_WRITE`（读/写）：对得到的缓冲区的更改最终将写入文件；但该更改对映射到同一文件的其他程序不一定是可见的。
- `MapMode.PRIVATE`（专用）：可读可写，但修改的内容不会写入文件，仅是 `buffer` 自身的改变，这种能力称为 “copy on write”。

`MappedByteBuffer` 作为 `ByteBuffer` 的子类，它同时也是一个抽象类，相比 `ByteBuffer`，它新增了三个方法：

- `isLoaded()`：如果缓冲区的内容在物理内存中，则返回 `true`，否则返回 `false`。
- `load()`：将缓冲区的内容载入内存，并返回该缓冲区的引用。
- `force()`：如果缓冲区处于 `READ_WRITE` 模式下，此方法会强制将缓冲区内容的修改写入文件。

### 与传统 IO 性能对比

相比传统 IO，`MappedByteBuffer` 就一个字，**快**！它之所以快速，是因为它采用了 direct buffer（内存映射） 的方式来读取文件内容。这种方式直接调动系统底层的缓存，没有 JVM 的参与，省去了内核空间和用户空间之间的复制操作，因此效率大大提高。

那么，`MappedByteBuffer` 相比传统 IO 快了多少呢？下面我们来做个小实验。

- 首先，我们写一个程序用来生成文件。

```java
int size = 1024 * 10;
File file = new File("/Users/chenssy/Downloads/fileTest.txt");

byte[] bytes = new byte[size];
for (int i = 0 ; i < size ; i++) {
    bytes[i] = new Integer(i).byteValue();
}

FileUtil.writeBytes(bytes,file);
```

通过更改 `size` 的数字，我们可以生成 10KB、1MB、10MB、100MB、1GB 五个文件。接下来，我们将使用这两个文件来对比 `MappedByteBuffer` 和传统 IO 读取文件内容的性能。

- 传统 IO 读取文件

```java
File file = new File("/Users/chenssy/Downloads/fileTest.txt");
FileInputStream in = new FileInputStream(file);
FileChannel channel = in.getChannel();

ByteBuffer buff = ByteBuffer.allocate(1024);

long begin = System.currentTimeMillis();
while (channel.read(buff) != -1) {
    buff.flip();
    buff.clear();
}
long end = System.currentTimeMillis();
System.out.println("time is:" + (end - begin));
```

- `MappedByteBuffer` 读取文件

```java
int BUFFER_SIZE = 1024;

File file = new File("/Users/chenssy/Downloads/fileTest.txt");
FileChannel fileChannel = new FileInputStream(file).getChannel();
MappedByteBuffer mappedByteBuffer = fileChannel.map(FileChannel.MapMode.READ_ONLY, 0,fileChannel.size());

byte[] b = new byte[1024];
int length = (int) file.length();

long begin = System.currentTimeMillis();

for (int i = 0 ; i < length ; i += 1024) {
    if (length - i > BUFFER_SIZE) {
        mappedByteBuffer.get(b);
    } else {
        mappedByteBuffer.get(new byte[length - i]);
    }
}

long end = System.currentTimeMillis();

System.out.println("time is:" + (end - begin));
```

测试电脑是 32GB 的 MacBook Pro， 对 10k，1M，10M，100M，1G 五个文件的测试结果如下：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411031813924.png" alt="image-20241103181312855" style="zoom:67%;" />

绿色是传统 IO 读取文件的，蓝色是使用 `MappedByteBuffer` 来读取文件的，从图中我们可以看出，文件越大，两者读取速度差距越大，所以 `MappedByteBuffer` 一般适用于大文件的读取。

## DirectByteBuffer

父类 `MappedByteBuffer` 已经做了基本的介绍，并且与传统 IO 做了对比，因此在这里我们不再对 `DirectByteBuffer` 进行详细介绍。接下来我们直接看源码，通过源码的分析，相信你会对堆外内存有更加深入的了解。

`DirectByteBuffer` 是包访问级别，其定义如下：

```java
class DirectByteBuffer extends MappedByteBuffer implements DirectBuffer {
   // ....
}
```

### 分配内存

DirectByteBuffer 可以通过 `ByteBuffer.allocateDirect(int capacity)` 进行构造。

```java
public static ByteBuffer allocateDirect(int capacity) {
    return new DirectByteBuffer(capacity);
}

DirectByteBuffer(int cap) {
    super(-1, 0, cap, cap);
    boolean pa = VM.isDirectMemoryPageAligned();
    int ps = Bits.pageSize();
    long size = Math.max(1L, (long)cap + (pa ? ps : 0));
    Bits.reserveMemory(size, cap);// ①

    long base = 0;
    try {

        base = unsafe.allocateMemory(size); // ②
    } catch (OutOfMemoryError x) {
        Bits.unreserveMemory(size, cap);
        throw x;
    }
    unsafe.setMemory(base, size, (byte) 0);
    if (pa && (base % ps != 0)) {
        // Round up to page boundary
        address = base + ps - (base & (ps - 1));
    } else {
        address = base;
    }
    cleaner = Cleaner.create(this, new Deallocator(base, size, cap));  // ③
    att = null;

}
```

### `Bits.reserveMemory(size, cap)`

这段代码有两个作用

1. 总分配内存(按页分配)的大小和实际内存的大小
2. 判断堆外内存是否足够，不够进行 GC 操作

```java
static void reserveMemory(long size, int cap) {

    if (!memoryLimitSet && VM.isBooted()) {
        // 获取最大堆外可分配内存
        maxMemory = VM.maxDirectMemory();
        memoryLimitSet = true;
    }

    // 判断是否够分配堆外内存
    if (tryReserveMemory(size, cap)) {
        return;
    }

    final JavaLangRefAccess jlra = SharedSecrets.getJavaLangRefAccess();

    // retry while helping enqueue pending Reference objects
    // which includes executing pending Cleaner(s) which includes
    // Cleaner(s) that free direct buffer memory
    while (jlra.tryHandlePendingReference()) {
        if (tryReserveMemory(size, cap)) {
            return;
        }
    }

    // trigger VM's Reference processing
    System.gc();

    // a retry loop with exponential back-off delays
    // (this gives VM some time to do it's job)
    boolean interrupted = false;
    try {
        long sleepTime = 1;
        int sleeps = 0;
        while (true) {
            if (tryReserveMemory(size, cap)) {
                return;
            }
            if (sleeps >= MAX_SLEEPS) {
                break;
            }
            if (!jlra.tryHandlePendingReference()) {
                try {
                    Thread.sleep(sleepTime);
                    sleepTime <<= 1;
                    sleeps++;
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
        }

        // no luck
        throw new OutOfMemoryError("Direct buffer memory");

    } finally {
        if (interrupted) {
            // don't swallow interrupts
            Thread.currentThread().interrupt();
        }
    }
}
```

`maxMemory = VM.maxDirectMemory()`，获取 JVM 允许申请的最大 DirectByteBuffer 的大小，该参数可通过 `XX:MaxDirectMemorySize `来设置。这里需要注意的是 `-XX:MaxDirectMemorySize`限制的是总 cap，而不是真实的内存使用量，因为在页对齐的情况下，真实内存使用量和总 cap 是不同的。

`tryReserveMemory()`可以统计 DirectByteBuffer 占用总内存的大小，如果发现堆外内存无法再次分配 DirectByteBuffer 则会返回 false，这个时候会调用 `jlra.tryHandlePendingReference()` 来进行会触发一次非堵塞的 `Reference#tryHandlePending(false)`，通过注释我们了解了该方法主要还是协助 ReferenceHandler 内部线程进行下一次 pending 的处理，内部主要是希望遇到 Cleaner，然后调用 `Cleaner#clean()` 进行堆外内存的释放。

如果还不行的话那就只能调用 `System.gc();` 了，但是我们需要注意的是，调用 `System.gc();` 并不能马上就可以执行 full gc，所以就有了下面的代码，下面代码的核心意思是，尝试 9 次，如果依然没有足够的堆外内存来进行分配的话，则会抛出异常 `OutOfMemoryError("Direct buffer memory")`。每次尝试之前都会 `Thread.sleep(sleepTime)`，给系统足够的时间来进行 full gc。

总体来说 `Bits.reserveMemory(size, cap)` 就是用来统计系统中 DirectByteBuffer 到底占用了多少，同时通过进行 GC 操作来保证有足够的内存空间来创建本次的 DirectByteBuffer 对象。所以对于堆外内存 DirectByteBuffer 我们依然可以不需要手动去释放内存，直接交给系统就可以了。还有一点需要注意的是，别设置 `-XX:+DisableExplicitGC`，否则 `System.gc()`就无效了。

### `base = unsafe.allocateMemory(size)`

到了这段代码我们就知道了，我们有足够的空间来创建 DirectByteBuffer 对象了。`unsafe.allocateMemory(size)`是一个 native 方法，它是在堆外内存（C_HEAP）中分配一块内存空间，并返回堆外内存的基地址。

```C
inline char* AllocateHeap( size_t size, MEMFLAGS flags, address pc = 0, AllocFailType alloc_failmode = AllocFailStrategy::EXIT_OOM){ 
   // ... 省略 
  char*p=(char*)os::malloc(size, flags, pc); 
  // 分配在 C_HEAP 上并返回指向内存区域的指针 
  // ... 省略 
  return p; 
}
```

### `cleaner = Cleaner.create(this, new Deallocator(base, size, cap));`

这段代码其实就是创建一个 `Cleaner` 对象，该对象用于对 DirectByteBuffer 占用对堆外内存进行清理，调用 `create()` 来创建 `Cleaner` 对象，该对象接受两个参数

1. Object referent：引用对象
2. Runnable thunk：清理线程

调用 `Cleaner#clean()` 进行清理，该方法其实就是调用 `thunk#run()`，也就是 `Deallocator#run()`：

```java
public void run() {
    if (address == 0) {
        // Paranoia
        return;
    }
    unsafe.freeMemory(address);
    address = 0;
    Bits.unreserveMemory(size, capacity);
}
```

方法很简单就是调用 `unsafe.freeMemory()` 释放掉指定堆外内存地址的内存空间，然后重新统计系统中的 DirectByteBuffer 的大小情况。

Cleaner 是 PhantomReference 的子类，PhantomReference 是虚引用，熟悉 JVM 的小伙伴应该知道虚引用的作用是跟踪垃圾回收器收集对象的活动，当该对象被收集器回收时收到一个系统通知，所以 Cleaner 的作用就是能够保证 JVM 在回收 DirectByteBuffer 对象时，能够保证相对应的堆外内存也释放。

### 释放内存

在创建 DirectByteBuffer 对象的时候，会 new 一个 Cleaner 对象，该对象是 PhantomReference 的子类，PhantomReference 为虚引用，它的作用在于跟踪垃圾回收过程，并不会对对象的垃圾回收过程造成任何的影响。

当 DirectByteBuffer 对象从 pending 状态 —> enqueue 状态，他会触发 `Cleaner#clean()`。

```Java
public void clean() {
    if (!remove(this))
        return;
    try {
        thunk.run();
    } catch (final Throwable x) {
        // ...
    }
}
```

在 `clean()` 方法中其实就是调用 `thunk.run()`，该方法有 DirectByteBuffer 的内部类 Deallocator 来实现：

```Java
public void run() {
    if (address == 0) {
        // Paranoia
        return;
    }
    // 释放内存
    unsafe.freeMemory(address);
    address = 0;
    Bits.unreserveMemory(size, capacity);
}
```

直接用 `unsafe.freeMemory()` 释放堆外内存了，这个 address 就是分配堆外内存的内存地址。

## 参考

* [Java内存区域详解（重点） | JavaGuide](https://javaguide.cn/java/jvm/memory-area.html)
* [深入分析堆外内存 DirectByteBuffer & MappedByteBuffer对于 ByteBuffer 而言 - 掘金](https://juejin.cn/post/7326923332196237351)
