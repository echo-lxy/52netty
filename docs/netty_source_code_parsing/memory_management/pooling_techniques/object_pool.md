# 详解 Recycler 对象池的精妙设计与实现

## 池化思想的应用

在日常开发中，我们经常会遇到各种池化技术的设计思想，例如连接池、内存池和对象池。在业务开发过程中，我们也常常缓存一些计算结果数据，这同样运用到了池化技术的设计思想，我们可以称之为结果池。

池化技术的应用场景是，当对象的创建和销毁需要较大的性能开销时，我们需要将这些重量级对象放在一个池中进行管理。这样，当需要时，可以直接从池中获取，避免重复创建和销毁的开销，从而实现复用。

例如，连接池中保存和管理的是网络连接对象，这些对象的创建和销毁代价较大。通过连接池，业务线程可以直接复用这些重量级网络连接对象，避免了重新创建和释放连接的性能开销及等待时间。

另一个例子是，我们在开发中遇到一些计算逻辑复杂的业务。通常，我们会先从数据库中查询数据，然后经过复杂的计算得出结果。为了避免下次重复计算，我们会将计算结果放入缓存中，这也可以视为一种结果池的应用。

再比如，在《Netty如何高效接收网络数据》一文中提到的内存池。为避免不必要的数据拷贝以及JVM垃圾回收对性能的影响，Netty选择使用堆外内存存储网络通信数据。在申请堆外内存之前，Netty首先在JVM堆中创建一个用于引用native memory的对象——DirectByteBuffer。然后，通过底层的`unsafe.allocateMemory`方法，使用系统调用`malloc`申请一块堆外内存。

这里涉及两个重要开销：首先是在JVM堆中创建DirectByteBuffer对象，并为其分配JVM堆内存；其次是通过`malloc`向操作系统申请堆外内存，并让DirectByteBuffer引用这块内存。然而，堆外内存的申请和释放开销远大于堆内内存的申请和释放。在Netty所面临的高并发网络通信场景中，申请堆外内存是一个非常频繁的操作，基于以上两个重要性能开销，这种大量频繁的内存申请和释放操作对程序性能的影响是巨大的。因此，Netty引入了内存池，以统一管理与内存相关的操作。

## 对象池简介

以上内容介绍了池化思想的应用及其所解决的问题，接下来，我们的主题是对象池。对象池的引入旨在解决需要大量创建和销毁对象的场景，通过池化对象实现复用，避免重复创建和销毁带来的性能开销。

在前面提到的内存池中，我们了解到Netty在高并发网络通信场景下需要频繁申请堆外内存以存储通信数据。在Netty中，通过`PooledDirectByteBuf`对象来引用堆外内存。因此，在处理网络I/O时，Netty需要大量频繁地创建`PooledDirectByteBuf`对象。为避免在高并发场景下大量创建对象带来的性能开销，我们可以引入对象池来池化创建的`PooledDirectByteBuf`对象：需要时直接从对象池中获取，使用后再回收到对象池中。

此外，这里提前透露一个信息，下一篇文章中将介绍Netty发送数据流程中对象池的应用。Netty是一个异步事件驱动的高性能网络框架。当业务线程处理完业务逻辑并准备响应结果到客户端时，会向对应的Channel写入业务结果，此时业务线程会立即返回，形成一个异步的过程。原因在于Netty的底层实现会将用户的响应结果数据暂时写入每个Channel特有的发送缓冲队列——`ChannelOutboundBuffer`。这意味着`ChannelOutboundBuffer`缓存着Channel中待发送的数据。

最终，这些待发送的数据会通过`flush`方法写入底层Socket，并发送给客户端。需要注意的是，发送缓冲队列`ChannelOutboundBuffer`中的队列元素是`Entry`类型的。每次写入操作都需要创建一个`Entry`对象来包裹发送的数据，并将这个对象缓存到`ChannelOutboundBuffer`中。这里大家只需了解`ChannelOutboundBuffer`的作用以及它缓存的对象类型为`Entry`，具体细节将在下篇文章中详细介绍。

在海量网络I/O场景下，Netty必然会频繁创建`Entry`对象。如果每次网络I/O都需要重新创建这些对象并最终被垃圾回收，无疑会增加JVM的负担和GC的时间，这对追求极致性能的Netty来说是不可接受的。因此，对象池用于管理那些需要频繁创建和使用的对象，使用后不立即释放，而是将它们缓存到对象池中，以供后续应用程序重复使用，从而减少对象的创建和释放开销，提高应用程序性能。

从另一个角度来看，对象池还可以限制对象的数量，有效减少应用程序的内存开销。经过上述对对象池的简要介绍，相信大家对其作用有了更深入的理解。接下来，笔者将为大家介绍对象创建和回收过程中所需的开销，以便大家全面清晰地理解对象池的机制。

## 对象在JVM中创建和回收开销

### 对象的创建开销

在Java程序中，我们可以通过`new`关键字来创建对象。当JVM遇到一条`new`的字节码指令时，会经历以下几个步骤：

1. **符号引用检查**：

- - JVM首先检查`new`指令后面的参数，即要创建对象所属的Java类是否能够在方法区的常量池中定位到类的符号引用。
  - 接着，JVM会检查这个符号引用所代表的类是否已经被加载、解析和初始化过。如果没有，JVM会先执行类的加载过程。

1. **内存分配**：

- - 一旦类加载检查通过，JVM将开始为对象分配内存。对象所需内存的大小在类加载完成后就已经确定，JVM要做的就是从堆中划分出一块确定大小的内存区域。
  - 关于如何确定对象所需内存大小，感兴趣的读者可以参考笔者的《对象在JVM中的内存布局》一文。

1. **内存分配方法**：

- - 在为对象划分堆内存时，JVM会根据堆内存的布局选择不同的分配方法，主要分为指针碰撞法和空闲列表法。
  - 在多线程环境下，多个线程同时创建对象时，JVM需要保证内存划分的线程安全性。这通常通过同步处理（如CAS加失败重试）来实现。

1. **TLAB（本地线程分配缓存）**：

- - 为了避免同步锁定，JVM引入了TLAB机制。每个线程可以先向JVM堆申请一块内存，当线程创建对象时，优先从自己的TLAB中分配内存。只有在TLAB用完时，线程才会去堆中同步分配。
  - 可以通过虚拟机参数`-XX:+UseTLAB`开启TLAB（默认开启），使用`-XX:-UseTLAB`关闭。

1. **内存初始化**：

- - 为对象分配好内存后，JVM会将这块内存初始化为零值。这样可以保证对象中的实例字段不赋初始值时，其值为字段对应数据类型的零值。

1. **设置对象头**：

- - JVM会设置对象头，包括在Mark Word中存储对象的运行时信息，并通过类型指针引用关联到类的元数据信息。有关这些内容的详细信息，大家可以回顾笔者的《对象在JVM中的内存布局》。

1. **执行构造函数**：

- - 最后，执行构造函数，至此，一个真正可用的对象就被创建出来了。

通过这些步骤，JVM实现了对象的创建和内存管理，从而支持Java程序的高效运行。

### 对象的回收开销

JVM中的垃圾回收器通过可达性分析探索所有Java存活对象。它从GC ROOTS出发，边标记边探索所有对象的引用链，以判断对象是否存活。

在垃圾回收的过程中，发生的GC PAUSE即为STOP THE WORLD。关于详细的垃圾回收过程，这里不再展开讨论，主要是为了指出对象回收时的两个主要开销点。

然而，在高并发的网络IO处理场景下，单个对象的创建和回收开销会被无限放大。因此，Netty引入了一个轻量级的对象池——**Recycler**，负责将这些需要频繁创建的对象进行池化，统一分配和回收管理。

在详细介绍Recycler的实现之前，笔者想先让大家通过对象池的使用，直观感受一下Recycler对外提供的功能入口。

## 对象池Recycler的使用

这里我们直接看下 Netty 源码中是如何使用 Recycler 对象池的，首先我们来看下对象池在 PooledDirectByteBuf 类中是如何使用的。

大家这里先不用去管这个PooledDirectByteBuf类是干吗的，只需要明白这个类是会被频繁创建的，我们这里主要是演示对象池的使用。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729943901574-cec86c90-f726-4c09-8c4c-2d75542c0d1f.webp)

### 对象池在PooledDirectByteBuf类中的使用

```java
final class PooledDirectByteBuf extends PooledByteBuf<ByteBuffer> {
    //创建对象池
    private static final ObjectPool<PooledDirectByteBuf> RECYCLER = ObjectPool.newPool(
        new ObjectCreator<PooledDirectByteBuf>() {
            @Override
            public PooledDirectByteBuf newObject(Handle<PooledDirectByteBuf> handle) {
                return new PooledDirectByteBuf(handle, 0);
            }
        });

    //对象在对象池中的回收句柄
    private final Handle<PooledByteBuf<T>> recyclerHandle;

    static PooledDirectByteBuf newInstance(int maxCapacity) {
        //从对象池中获取对象
        PooledDirectByteBuf buf = RECYCLER.get();
        buf.reuse(maxCapacity);
        return buf;
    }

    private void recycle() {
        //回收对象
        recyclerHandle.recycle(this);
    }

    ................省略和对象池无关的代码..................
}
```

前面提到，在Netty中需要频繁创建`PooledDirectByteBuf`对象。为了避免在高并发场景下频繁创建对象的开销，引入了对象池来统一管理这些对象。

在Netty中，每个被池化的对象都会引用对象池的实例`ObjectPool RECYCLER`。这个对象池专门用来分配和管理被池化的对象。

我们创建的对象池是专门管理`PooledDirectByteBuf`对象的，通过泛型指定对象池需要管理的具体对象。泛型类`ObjectPool<T>`是Netty为对象池设计的一个顶层抽象，定义了对象池的行为和功能。我们可以通过`ObjectPool#newPool`方法创建指定的对象池，其参数`ObjectCreator`接口用来定义创建池化对象的行为。当对象池中需要创建新对象时，就会调用该接口的方法`ObjectCreator#newObject`来创建对象。

每个池化对象中都会包含一个`recyclerHandle`，它是池化对象在对象池中的句柄，封装了与对象池相关的一些行为和信息。`recyclerHandle`在对象池创建对象后传递进来。

当需要`PooledDirectByteBuf`对象时，可以直接通过`RECYCLER.get()`从对象池中获取对象。使用完毕后，直接调用`PooledDirectByteBuf`对象在对象池中的句柄`recyclerHandle.recycle(this)`将对象回收到对象池中。

### 对象池在Channel写入缓冲队列中的使用

前面提到，每个`Channel`都有一个独立的写入缓冲队列`ChannelOutboundBuffer`，用来暂时存储用户的待发送数据。这样，用户在调用`channel`的`write`方法后，可以立即返回，实现异步发送流程。

在发送数据时，`Channel`首先将用户要发送的数据缓存在自己的写缓存队列`ChannelOutboundBuffer`中。`ChannelOutboundBuffer`中的元素类型为`Entry`。在Netty中，`Entry`对象会频繁被创建，因此也需要使用对象池进行管理。

在上一小节介绍`PooledDirectByteBuf`对象池的过程中，大家应该已经对对象池的使用套路有了一定的了解。接下来，我们借助`Entry`对象池将使用步骤总结如下：

#### 创建对象池

```java
static final class Entry {

    private static final ObjectPool<Entry> RECYCLER = ObjectPool.newPool(new ObjectCreator<Entry>() {
        @Override
        public Entry newObject(Handle<Entry> handle) {
            return new Entry(handle);
        }
    });

    //recyclerHandle用于回收对象
    private  Handle<Entry> handle;
    
    private Entry(Handle<Entry> handle) {
        this.handle = handle;
    }
}
```

前边我们介绍到每一个要被池化的对象都需要一个静态变量来引用其对应的对象池。

```java
static final ObjectPool<Entry> RECYCLER 
```

匿名实现 ObjectCreator接口来定义对象创建的行为方法

```java
public interface ObjectCreator<T> {
    T newObject(Handle<T> handle);
}
```

通过`ObjectPool#newPool`创建用于管理`Entry`对象的对象池。

在对象池创建对象时，会为池化对象创建其在对象池中的句柄`Handler`，随后将`Handler`传入创建好的池化对象中。当对象使用完毕后，我们可以通过`Handler`将对象回收至对象池中，等待下次继续使用。

#### 从对象池中获取对象

由于`Entry`对象在设计上是由对象池管理的，因此不对外提供`public`构造函数，无法在外部直接创建`Entry`对象。

因此，池化对象通常会提供一个获取对象实例的`static`方法`newInstance`。在该方法中，通过`RECYCLER.get()`从对象池中获取对象实例。

```java
static Entry newInstance(Object msg, int size, long total, ChannelPromise promise) {
    Entry entry = RECYCLER.get();
    
    .........省略无关代码..............

    return entry;
}
```

#### 使用完毕回收对象

池化对象都会提供一个 recycle 方法，当对象使用完毕后，调用该方法将对象回收进对象池中。

```java
void recycle() {
    next = null;
    bufs = null;
    buf = null;
    msg = null;
    promise = null;
    progress = 0;
    total = 0;
    pendingSize = 0;
    count = -1;
    cancelled = false;
    handle.recycle(this);
}
```

清空对象中的所有属性。

通过对象中持有的对象池句柄`Handler`，将对象回收至对象池中。

------

从上面列举的Netty中使用对象池的例子，我们可以直观地感受到对象池的使用非常简单。主要包括从对象池获取对象和将对象回收至对象池这两个核心步骤。

同时，我们也注意到池化对象的设计与普通对象有所不同。不过，我们只需遵循本小节中列举的几个步骤进行设计即可。

## Recycler总体设计

`Recycler`对象池的设计相对复杂，但却非常精妙。因此，笔者在此继续采用总—分—总的结构来介绍对象池的设计与实现。

一开始，我们不必追求过于细节的内容，而是要从总体上理解对象池的设计架构，以及各个功能模块之间的关联。

当我们从整体上理解了对象池的设计架构后，笔者将分模块详细讲解其实现细节。

在理清楚各个模块的实现细节之后，笔者会从细节入手，再次将对象池的整体设计架构串联起来。

我们按照这个思路，先来看一下`Recycler`对象池的总体架构设计图，从整体上直观感受它的设计以及包含的一些重要模块。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729945091223-1a259902-7a38-4b70-ac3f-848cdd3c66f1.webp)

### 多线程获取对象无锁化设计

首先，从外部整体来看，对象池就像是一个存储对象的池子。当我们需要对象时，可以直接从这个池子里获取；用完对象后，再将其归还回池子，以方便下一次重复使用。

然而，俯瞰整个对象池的设计架构时，我们会发现其中蕴含了不少精妙的细节，使得设计相对复杂。

对象池中最重要的两个结构是 **Stack** 和 **WeakOrderQueue**。

- **Stack** 中包含一个用数组实现的栈结构（图中绿色部分），这是对象池中真正用于存储池化对象的地方。每次从对象池中获取对象时，都会从这个栈结构中弹出栈顶元素。同样，每次将使用完的对象归还到对象池中，也是将对象压入这个栈结构中。

这里有一个精妙的设计：每个线程都会拥有一个属于自己的 `Stack`。在介绍《对象创建的开销》这一小节时，我们提到为了避免多线程并发申请内存时的同步锁定开销，JVM为每个线程预先申请了一块内存（TLAB），这样线程创建对象时都是从自己的 TLAB 中分配内存，从而避免了多线程之间的同步竞争。

同样地，当多线程并发从对象池中获取对象时，如果整个对象池只有一个 `Stack` 结构，为了保证多线程获取对象的线程安全性，我们只能同步访问这个 `Stack`，这将引入多线程同步竞争的开销。因此，设计多个 `Stack` 结构对于提高并发性能至关重要。

**为了避免这种不必要的同步竞争，Netty也采用了类似TLAB分配内存的方式，每个线程拥有一个独立Stack，这样当多个线程并发从对象池中获取对象时，都是从自己线程中的Stack中获取，全程无锁化运行。大大提高了多线程从对象池中获取对象的效率**。

这种**多线程并发无锁化**的设计思想，在Netty中比比皆是

### Stack的设计

从`Recycler`对象池的整体设计架构图中，我们可以看到`Stack`的设计主要分为两个重要部分：

1. **数组实现的栈结构**：用于存放对象池中的对象。每个线程绑定一个独立的 `Stack`，用来存储由该线程创建并回收到对象池中的对象。
2. **WeakOrderQueue链表**：链表的`head`指针指向链表的头结点，`cursor`指针指向链表的当前节点，`prev`指针指向当前节点的前一个节点。`WeakOrderQueue`链表用于存储其他线程帮助本线程回收的对象（称之为待回收对象）。在`WeakOrderQueue`链表中，每个节点对应一个其他线程，该线程为本线程回收的对象存储在相应的 `WeakOrderQueue` 节点中。

这里我们先不需要管WeakOrderQueue的具体结构

**那么Stack结构在设计上为什么要引入这个WeakOrderQueue链表呢？**

让我们考虑一种多线程对象回收的场景，以 Recycler 对象池的整体设计架构图为例。在这个示例中，`thread1` 代表当前线程，而 `thread2`、`thread3` 和 `thread4` 则为其他线程。接下来，我们将重点关注当前线程的行为和作用。    

**我们先假设Stack结构中只有一个数组栈，并没有WeakOrderQueue链表。看看这样会产生什么后果？**

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729945552571-5ff4e2a7-564c-4aa3-ab82-d624c663dffe.webp)

当前线程 `thread1` 在处理业务逻辑时创建了一个对象（注意：该对象是由 `thread1` 创建的）。如果这是一个单线程处理业务的场景，创建的对象将在 `thread1` 完成业务逻辑后被回收，并存放至 `thread1` 对应的 `stack1` 中的数组栈。当 `thread1` 再次需要创建对象时，会直接从其对应的 `stack1` 中的数组栈（图中绿色部分）获取上次回收的对象。

由此可见，`stack` 中的数组栈（绿色部分）存放的是真正被回收的对象，可以被直接重新使用。

然而，在多线程处理业务的场景中，`thread1` 创建的对象可能会被 `thread2` 或 `thread3` 等其他线程用来处理后续的业务逻辑。因此，当这些其他线程处理完业务后，对象的释放并不是在 `thread1` 中，而是在其他线程中完成。

此时，其他线程的任务是将 `thread1` 创建的对象释放回收至 `thread1` 对应的 `stack1` 中的数组栈。如果多个其他线程并发地向 `stack1` 释放对象，势必会导致多线程之间的同步竞争。为此，Netty 将不得不将 `stack` 结构中的数组栈访问设计成一个同步过程。

更不巧的是，当前线程 `thread1` 也需要同时向自己的 `stack1` 获取对象。在这种情况下，`thread1` 将只能进行同步等待，因为其他线程正在向 `stack1` 释放对象。

本来引入对象池的目的在于抵消创建对象的开销、加快获取对象的速度并减少 GC 的压力。然而，由于 `stack` 的同步访问设计引入了同步开销，这种开销甚至可能超过创建对象的开销，从而使得对象池的引入变得得不偿失。

**那么Netty该如何化解这种情况呢？答案还是之前反复强调的无锁化设计思想。**

既然多线程对象回收的场景会引入多线程之间的同步锁定开销，我们可以采用无锁化的设计思想，为每个线程（注意，这里指的是非创建对象的线程，例如图中的 `thread2`、`thread3` 等）单独分配一个 `WeakOrderQueue` 节点。在为创建线程回收对象时，这些回收线程会将对象暂时存放到各自对应的 `WeakOrderQueue` 节点中。

需要注意的是，存放在 `WeakOrderQueue` 中的对象被称为待回收对象。这些待回收对象并不在 `Stack` 结构中的数组栈中，因此不能被直接获取使用。

为了方便后续描述，我们将创建对象的线程称作创建线程（示例中的 `thread1`），将为创建线程回收对象的其他线程称作回收线程（例如 `thread2`、`thread3`、`thread4` 等）。

将视角拉回到创建线程 `thread1` 对应的 `stack1` 中。每个回收线程将待回收对象放入与自己对应的 `WeakOrderQueue` 节点中，从而避免在多线程回收场景中的同步竞争。当所有回收线程都在为 `stack1` 回收对象时，就形成了一个 `WeakOrderQueue` 链表。每个回收线程只操作与自己对应的节点。在 `Stack` 结构中，通过 `head`、`prev` 和 `cursor` 将这些 `WeakOrderQueue` 节点组合成一个链表。

每一个 `WeakOrderQueue` 节点对应一个回收线程。

当创建线程 `thread1` 再次从自己对应的 `stack1` 中获取对象时，只会从 `Stack` 结构的数组栈中获取。由于这是单线程操作数组栈，自然不会存在同步竞争。

当 `Stack` 结构中的数组栈没有任何对象时，创建线程会根据 `cursor` 指针遍历 `Stack` 结构中的 `WeakOrderQueue` 链表，将当前 `WeakOrderQueue` 节点存放的待回收对象转移至数组栈中。如果 `WeakOrderQueue` 链表中也没有任何待回收对象可供转移，创建线程将直接在对象池中创建一个新对象并返回。

对象池回收对象的原则是：对象由谁创建，最终就要被回收到创建线程对应的 `Stack` 结构中的数组栈中。数组栈中存放的才是真正被回收的池化对象，可以直接被取出复用。回收线程只能将待回收对象暂时存放至创建线程对应的 `Stack` 结构中的 `WeakOrderQueue` 链表中。当数组栈中没有对象时，由创建线程将 `WeakOrderQueue` 链表中的待回收对象转移至数组栈中。

**正是由于对象池的这种无锁化设计，对象池在多线程获取对象和多线程回收对象的场景下，均是不需要同步的**

大家在体会下这张图中蕴含的这种**无锁化设计思想**：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729948308847-6c181066-c568-4629-af23-3171147e4d7a.webp)

### WeakOrderQueue的设计

在我们介绍完对象池在多线程回收对象场景下的设计时，我们再来看下用于回收线程存储待回收对象的WeakOrderQueue是如何设计的？

注意：这里的回收线程，待回收对象这些概念是我们站在创建线程的视角提出的相对概念。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729948351668-1fa8e762-e59f-417e-9eff-6efbc76cb229.webp)

大家一开始可能会从 **WeakOrderQueue** 的字面意思上以为它的结构是一个队列，但实际上从图中可以看出，**WeakOrderQueue** 的结构是一个链表结构。

这个链表包含链表的头结点 **Head** 以及链表的尾结点指针 **Tail**。链表中的元素类型为 **Link** 类型。

**Link** 类型中包含一个 **elements** 数组，用来存放回收线程收集的待回收对象。除此之外，**Link** 类型还包含：

- **readIndex**：指示当前 **elements** 数组中的读取位置。
- **writeIndex**：指示 **elements** 数组的写入位置。

**elements** 数组的容量默认为 16，也就是说一个 **Link** 节点最多可以存放 16 个待回收对象。当回收线程收集的待回收对象超过 16 个时，会新创建一个 **Link** 节点并插入到 **Link** 链表的尾部。

当需要将 **WeakOrderQueue** 节点中存放的待回收对象回收并转移至其对应的 **Stack** 结构中的数组栈时，创建线程会遍历当前 **WeakOrderQueue** 节点中的 **Link** 链表，从链表的 **Head** 节点开始，将 **Head** 节点中存放的待回收对象转移至创建线程对应的 **Stack** 中。一次最多转移一个 **Link** 大小的待回收对象（16 个）。

当 **Link** 节点中的待回收对象全部转移至创建线程对应的 **Stack** 中时，会立即将这个 **Link** 节点从当前 **WeakOrderQueue** 节点中的 **Link** 链表中删除，随后 **Head** 节点向后移动，指向下一个 **Link** 节点。

**head** 指针始终指向第一个未被转移完毕的 **Link** 节点，创建线程从 **head** 节点处读取待回收对象，回收线程从 **Tail** 节点处插入待回收对象。这样，转移操作和插入操作互不影响，且没有同步开销。

需要注意的是，这里会存在线程可见性的问题，也就是说，回收线程刚插入的待回收对象，创建线程在转移这些待回收对象时，可能会看不到刚刚插入的待回收对象。

Netty 为了不引入多线程同步的开销，只会保证待回收对象的最终可见性。如果要保证待回收对象的实时可见性，就需要插入一些内存屏障指令，而执行这些内存屏障指令也是需要开销的。

事实上，这里并不需要保证实时可见性，创建线程暂时看不到 **WeakOrderQueue** 节点中的待回收对象也没关系，最坏的情况下只需新创建一个对象。这里依然遵循无锁化的设计思想。

维护线程之间操作的原子性和可见性都是需要开销的。在日常多线程程序设计中，我们一定要根据业务场景进行综合考虑，权衡取舍。尽量遵循多线程无锁化设计思想，提高多线程的运行效率，避免引入不必要的同步开销。

综合以上 **Netty Recycler** 对象池的设计原理，我们可以看到，多线程从对象池中获取对象，以及多线程将对象回收至对象池中，和创建线程从 **WeakOrderQueue** 链表中转移待回收对象到对象池中的步骤均是无锁化进行的，没有同步竞争。

在理解了对象池的基本设计原理后，下面就该介绍对象池在 **Netty** 中的源码实现环节。

## Recycler 对象池的实现

在小节《4. 对象池Recycler的使用》中，我们介绍了Recycler对象池的两个使用案例：

- **对象池在**`PooledDirectByteBuf`**类中的运用**。
- **对象池在**`Channel`**对应的写入缓冲队列**`ChannelOutboundBuffer`**中的运用**。

从这两个案例中，我们看到在设计池化对象时，都需要在池化对象内部持有一个对象池的静态引用，以便与对象池进行交互。该引用的类型为 `ObjectPool`，`ObjectPool` 是Netty对象池的顶层设计，其中定义了对象池的行为及各种顶层接口。

在介绍对象池的整体实现之前，我们先来看一下对象池的这个顶层接口设计。

### 对象池的顶层设计ObjectPool

```java
public abstract class ObjectPool<T> {

    ObjectPool() { }

    public abstract T get();

    public interface Handle<T> {
        void recycle(T self);
    }

    public interface ObjectCreator<T> {
        T newObject(Handle<T> handle);
    }

    ......................省略............

}
```

我们首先看到 `ObjectPool` 被设计为一个泛型的抽象类。使用泛型的原因在于，在创建对象池时需要指定对象池中被池化对象的类型。

例如，在《4. 对象池Recycler的使用》小节中提到的这两个案例：

```java
static final class Entry {

    private static final ObjectPool<Entry> RECYCLER

}
final class PooledDirectByteBuf extends PooledByteBuf<ByteBuffer> {

    private static final ObjectPool<PooledDirectByteBuf> RECYCLER

}
```

ObjectPool 定义了从对象池中获取对象的行为：

```java
public abstract T get();
```

将池化对象回收至对象池中的行为被定义在 Handler 内部接口中：

```java
public interface Handle<T> {
    void recycle(T self);
} 
```

`Handler` 是池化对象在对象池中的一个模型，它包装了池化对象，并包含了一些回收信息及池化对象的回收状态。其默认实现为 `DefaultHandle`，后面我们会对此进行详细介绍。

在前面提到的 Stack 结构中的数组栈里，存放的就是 `DefaultHandle`；而在 `WeakOrderQueue` 结构里的 Link 节点中的 elements 数组里，同样存放着 `DefaultHandle`。

那么，为什么要将池化对象的回收行为 `recycle` 定义在 `Handler` 中，而不是 `ObjectPool` 中呢？

从业务线程的角度来看，业务线程处理的都是对象级别的维度，并不需要感知到对象池的存在。使用完对象后，只需直接调用对象的回收方法 `recycle`，将池化对象回收即可。

在《4. 对象池Recycler的使用》小节中，我们提到池化对象的设计方法，强调池化对象中需要引用其在对象池中的 `Handler`。这个 `Handler` 会在对象池创建对象时传入。池化对象类型需要定义 `recycle` 方法，该方法清空池化对象的所有属性，并调用 `Handler` 的 `recycle` 方法，将池化对象回收至对象池中。

```java
static final class Entry {

    void recycle() {
        next = null;
        bufs = null;
        buf = null;
        msg = null;
        promise = null;
        progress = 0;
        total = 0;
        pendingSize = 0;
        count = -1;
        cancelled = false;
        handle.recycle(this);
    }

}
```

ObjectPool 还定义了对象池创建对象的行为接口：

```java
public interface ObjectCreator<T> {
    T newObject(Handle<T> handle);
}
```

用户在创建对象池的时候，需要通过`ObjectCreator#newObject`方法指定对象池创建对象的行为。Handler对象正是通过这个接口传入池化对象中的。

```java
static final class Entry {

  private static final ObjectPool<Entry> RECYCLER = ObjectPool.newPool(new ObjectCreator<Entry>() {
        @Override
        public Entry newObject(Handle<Entry> handle) {
            return new Entry(handle);
        }
    });

  //Entry对象只能通过对象池获取，不可外部自行创建
  private Entry(Handle<Entry> handle) {
        this.handle = handle;
    }

}
```

#### 创建ObjectPool

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729949184512-c3c73d10-3ea5-4d11-a98b-41e490f49032.webp)

```java
public abstract class ObjectPool<T> {

    public static <T> ObjectPool<T> newPool(final ObjectCreator<T> creator) {
        return new RecyclerObjectPool<T>(ObjectUtil.checkNotNull(creator, "creator"));
    }

    private static final class RecyclerObjectPool<T> extends ObjectPool<T> {
        //recycler对象池实例
        private final Recycler<T> recycler;

        RecyclerObjectPool(final ObjectCreator<T> creator) {
             recycler = new Recycler<T>() {
                @Override
                protected T newObject(Handle<T> handle) {
                    return creator.newObject(handle);
                }
            };
        }

        @Override
        public T get() {
            return recycler.get();
        }
    }

}
public abstract class Recycler<T> {

    protected abstract T newObject(Handle<T> handle);
  
    ........................省略.............
}
```



调用 `ObjectPool#newPool` 创建对象池时，返回的是 `RecyclerObjectPool` 实例，而真正的对象池 `Recycler` 被包裹在 `RecyclerObjectPool` 中。

对象池 `Recycler` 创建对象的行为是由用户在创建对象池时指定的 `ObjectCreator` 定义的。

## Recycler对象池属性详解

在介绍完对象池的顶层设计之后，接下来我们将介绍 `Recycler` 对象池相关的一些重要属性。相信大家在看过前面关于对象池设计原理的介绍后，现在能够比较容易地理解即将介绍的这些属性概念。

由于涉及到的属性较多，笔者将这些属性的介绍放到源码实现之前，目的是让大家先对这些概念有一个初步的认识，熟悉这些属性的含义。在介绍源码实现时，笔者还会再次提及这些属性，以便进行更深入的理解。

### 创建线程，回收线程的Id标识

```java
public abstract class Recycler<T> {

    //用于产生池化对象中的回收Id,主要用来标识池化对象被哪个线程回收
    private static final AtomicInteger ID_GENERATOR = new AtomicInteger(Integer.MIN_VALUE);
    //用于标识创建池化对象的线程Id 注意这里是static final字段 也就意味着所有的创建线程OWN_THREAD_ID都是相同的
    //这里主要用来区分创建线程与非创建线程。多个非创建线程拥有各自不同的Id
    //这里的视角只是针对池化对象来说的：区分创建它的线程，与其他回收线程
    private static final int OWN_THREAD_ID = ID_GENERATOR.getAndIncrement();

}
```

- `**AtomicInteger ID_GENERATOR**`：对象池中定义了一个 `AtomicInteger` 类型的 ID 生成器，主要用于为创建线程和回收线程生成 ID 标识，目的是区分创建线程和回收线程。
- `**int OWN_THREAD_ID**`：在 `Recycler` 类初始化时，会利用 `ID_GENERATOR` 为 `OWN_THREAD_ID` 字段赋值。从字面意思上来看，`OWN_THREAD_ID` 是用来标识创建线程的 ID。需要注意的是，`OWN_THREAD_ID` 是一个 `static final` 字段，这意味着所有的 `Recycler` 对象池实例中的 `OWN_THREAD_ID` 都是相同的。

在多线程环境中，从对象池中获取对象的场景可能会引发一些疑问。例如，图中展示了多个线程（如 `thread1`、`thread2`、`thread3` 等），但所有的 Recycler 对象池实例中的 `OWN_THREAD_ID` 都是相同的。那么，我们该如何区分这些不同的创建线程呢？  

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729949613215-39d5a76c-96e7-408b-be21-4b32a8197d44.webp)

实际上，在对象池中，我们并不需要区分不同创建线程之间的 ID，因为 Netty 的对象池设计采用了无锁化的策略。在这种设计中，各个创建线程之间并不需要交互。每个线程只需关注自身线程内的对象管理工作。因此，从一个线程的内部视角来看，只有一个创建线程，即它自己，其余线程均为回收线程。

在对象池的设计中，我们只需区分创建线程与回收线程。每个回收线程的 ID 是唯一的，且由其对应的 `WeakOrderQueue` 节点分配。具体来说，一个 `WeakOrderQueue` 实例对应一个回收线程 ID，这样的设计能够有效地管理对象的创建与回收，避免了线程间的竞争，提高了性能。

这种设计思路在多线程环境下极大地简化了对象池的管理，使得对象的创建与回收能够高效且安全地进行。

```java
private static final class WeakOrderQueue extends WeakReference<Thread> {

    //回收线程回收Id,每个weakOrderQueue分配一个，同一个stack下的一个回收线程对应一个weakOrderQueue节点
    private final int id = ID_GENERATOR.getAndIncrement();
}
```

### 对象池中的容量控制

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729949727961-7ccc743c-8051-48b1-8be2-19335a673d61.webp)

```java
//对象池中每个线程对应的Stack中可以存储池化对象的默认初始最大个数 默认为4096个对象 
private static final int DEFAULT_INITIAL_MAX_CAPACITY_PER_THREAD = 4 * 1024; // Use 4k instances as default.
// 对象池中线程对应的Stack可以存储池化对象默认最大个数 4096
private static final int DEFAULT_MAX_CAPACITY_PER_THREAD;
// 初始容量 min(DEFAULT_MAX_CAPACITY_PER_THREAD, 256) 初始容量不超过256个
private static final int INITIAL_CAPACITY;
```

Recycler 对象池中定义了以上三个属性用于控制对象池中可以池化的对象容量。这些属性对应的初始化逻辑如下：

```java
static {

    int maxCapacityPerThread = SystemPropertyUtil.getInt("io.netty.recycler.maxCapacityPerThread",
            SystemPropertyUtil.getInt("io.netty.recycler.maxCapacity", DEFAULT_INITIAL_MAX_CAPACITY_PER_THREAD));
    if (maxCapacityPerThread < 0) {
        maxCapacityPerThread = DEFAULT_INITIAL_MAX_CAPACITY_PER_THREAD;
    }

    DEFAULT_MAX_CAPACITY_PER_THREAD = maxCapacityPerThread;

    INITIAL_CAPACITY = min(DEFAULT_MAX_CAPACITY_PER_THREAD, 256);
}
```

- `DEFAULT_INITIAL_MAX_CAPACITY_PER_THREAD`：定义每个创建线程对应的 Stack 结构中数组栈的初始默认最大容量，默认为 4096。该值可以通过 JVM 启动参数 `-Dio.netty.recycler.maxCapacity` 进行指定。
- `DEFAULT_MAX_CAPACITY_PER_THREAD`：定义每个创建线程对应的 Stack 结构中数组栈的最大容量。可以通过 JVM 启动参数 `-Dio.netty.recycler.maxCapacityPerThread` 指定。如果未特别指定，则默认为 `DEFAULT_INITIAL_MAX_CAPACITY_PER_THREAD` 的值，即 4096。
- `INITIAL_CAPACITY`：定义每个创建线程对应的 Stack 结构中数组栈的初始容量。其计算公式为 `min(DEFAULT_MAX_CAPACITY_PER_THREAD, 256)`，默认为 256。当池化对象超过 256 个时，系统将对对象池进行扩容，但扩容后的容量不能超过最大容量 `DEFAULT_MAX_CAPACITY_PER_THREAD`。

### 回收线程可回收对象的容量控制

```java
//用于计算回收线程可帮助回收的最大容量因子  默认为2  
private static final int MAX_SHARED_CAPACITY_FACTOR;
//每个回收线程最多可以帮助多少个创建线程回收对象 默认：cpu核数 * 2
private static final int MAX_DELAYED_QUEUES_PER_THREAD;
//回收线程对应的WeakOrderQueue节点中的Link链表中的节点存储待回收对象的容量 默认为16
private static final int LINK_CAPACITY;
```

Recycler 对象池除了对创建线程中的 Stack 容量进行限制外，还需要对回收线程可回收对象的容量进行限制。相关回收容量限制属性初始化逻辑如下：

```java
static {

    MAX_SHARED_CAPACITY_FACTOR = max(2,
            SystemPropertyUtil.getInt("io.netty.recycler.maxSharedCapacityFactor",
                    2));

    MAX_DELAYED_QUEUES_PER_THREAD = max(0,
            SystemPropertyUtil.getInt("io.netty.recycler.maxDelayedQueuesPerThread",
                    // We use the same value as default EventLoop number
                    NettyRuntime.availableProcessors() * 2));

    LINK_CAPACITY = safeFindNextPositivePowerOfTwo(
            max(SystemPropertyUtil.getInt("io.netty.recycler.linkCapacity", 16), 16));

}
```

- `MAX_SHARED_CAPACITY_FACTOR`：此参数用于计算创建线程对应的 Stack 结构中，所有回收线程可以共同帮助回收的对象总量的因子。默认为 2，且可以通过 JVM 参数 `-Dio.netty.recycler.maxSharedCapacityFactor` 进行指定。通过该参数计算的总回收对象量由对象池的最大容量与该因子相乘得出。计算公式为：`max(maxCapacity / maxSharedCapacityFactor, LINK_CAPACITY)`。由此可得，创建线程对应的所有回收线程总共可以帮助回收的对象总量默认为 2048 个，而最小回收容量为 `LINK_CAPACITY`，默认为 16。
- `MAX_DELAYED_QUEUES_PER_THREAD`：该参数定义每个回收线程最多可以帮助多少个创建线程回收对象。默认为 `CPU 核数 * 2`，并可以通过 JVM 参数 `-Dio.netty.recycler.maxDelayedQueuesPerThread` 指定。需要注意的是，这里是从回收线程的角度进行考虑的。
- `LINK_CAPACITY`：在创建线程对应的 Stack 结构中的 `WeakOrderQueue` 链表中，回收线程对应的 `WeakOrderQueue` 节点的 Link 链表中，存储待回收对象的容量。默认为 16，可以通过 JVM 参数 `-Dio.netty.recycler.linkCapacity` 进行指定。



为了方便大家理解这些容量控制的相关参数，笔者又在对象池架构设计图的基础上补充了容量控制相关的信息。大家可以对照上边介绍到的这些参数的含义形象体会下：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729949929416-87e56928-b7ad-4d7a-b515-066e22b031f3.webp)

### 对象回收频率控制

对象池的设计需要考虑容量限制，而不仅仅是盲目地进行对象回收。我们在日常架构设计和程序开发中，应当具备保障方案，例如限流、降级和熔断等机制，以防止程序被突发的异常流量压垮。

在对象池的设计中，Netty使用以下两个参数来控制对象回收的频率，从而避免对象池迅速膨胀并失去控制。

```java
//创建线程回收对象时的回收比例，默认是8，表示只回收1/8的对象。也就是产生8个对象回收一个对象到对象池中
private static final int RATIO;
//回收线程回收对象时的回收比例，默认也是8，同样也是为了避免回收线程回收队列疯狂增长 回收比例也是1/8
private static final int DELAYED_QUEUE_RATIO;
```

对象回收频率控制参数的初始化逻辑如下：

```java
static {

    RATIO = max(0, SystemPropertyUtil.getInt("io.netty.recycler.ratio", 8));

    DELAYED_QUEUE_RATIO = max(0, SystemPropertyUtil.getInt("io.netty.recycler.delayedQueue.ratio", RATIO));

}
```

通过前面的 **Recycler** 对象池设计原理的介绍，我们了解到，池化对象的回收是由两类线程执行的。

- 一类是 **创建线程**。池化对象在创建线程中被创建后，始终在该线程中处理。处理完毕后，创建线程直接进行回收。为了避免对象池不可控地迅速膨胀，我们需要限制创建线程回收对象的频率。这个回收频率由参数 **RATIO** 控制，默认为 **8**，也可以通过 JVM 启动参数 `-D io.netty.recycler.ratio` 指定。具体来说，这意味着创建线程每创建 **8** 个对象，只回收 **1** 个对象。
- 另一类是 **回收线程**。池化对象在创建线程中被创建，但与业务相关的处理是在回收线程中进行的。业务处理完毕后，由回收线程负责回收这些对象。根据对象回收的基本原则，“对象是谁创建的，就要回收到对应创建线程的堆栈中”。因此，回收线程需要将池化对象回收到其创建线程对应的 **Stack** 中的 **WeakOrderQueue** 链表中，并等待创建线程将链表中的待回收对象转移至 **Stack** 中的数组栈中。同样，回收线程也需要控制回收频率，该频率由参数 **DELAYED_QUEUE_RATIO** 控制，默认值也是 **8**，可以通过 JVM 启动参数 `-D io.netty.recycler.delayedQueue.ratio` 指定。这表示回收线程每处理 **8** 个对象后才回收 **1** 个对象。

## Recycler对象池的创建

```java
private static final class RecyclerObjectPool<T> extends ObjectPool<T> {
    //recycler对象池实例
    private final Recycler<T> recycler;

    RecyclerObjectPool(final ObjectCreator<T> creator) {
         recycler = new Recycler<T>() {
            @Override
            protected T newObject(Handle<T> handle) {
                return creator.newObject(handle);
            }
        };
    }
  
    ..................省略............
  }
```

 Netty 中的 **Recycler** 对象池是一个抽象类，封装了对象池的核心结构和核心方法。在创建对象池时，我们通常会使用 **Recycler** 的匿名类来实现抽象方法 `newObject`，以定义对象池创建对象的行为。  

```java
public abstract class Recycler<T> {

   protected abstract T newObject(Handle<T> handle);

   protected Recycler() {
        this(DEFAULT_MAX_CAPACITY_PER_THREAD);
    }

    protected Recycler(int maxCapacityPerThread) {
        this(maxCapacityPerThread, MAX_SHARED_CAPACITY_FACTOR);
    }

    protected Recycler(int maxCapacityPerThread, int maxSharedCapacityFactor) {
        this(maxCapacityPerThread, maxSharedCapacityFactor, RATIO, MAX_DELAYED_QUEUES_PER_THREAD);
    }

    protected Recycler(int maxCapacityPerThread, int maxSharedCapacityFactor,
                       int ratio, int maxDelayedQueuesPerThread) {
        this(maxCapacityPerThread, maxSharedCapacityFactor, ratio, maxDelayedQueuesPerThread,
                DELAYED_QUEUE_RATIO);
    }

    //创建线程持有对象池的最大容量
    private final int maxCapacityPerThread;
    //所有回收线程可回收对象的总量(计算因子)
    private final int maxSharedCapacityFactor;
    //创建线程的回收比例
    private final int interval;
    //一个回收线程可帮助多少个创建线程回收对象
    private final int maxDelayedQueuesPerThread;
    //回收线程回收比例
    private final int delayedQueueInterval;

    protected Recycler(int maxCapacityPerThread, int maxSharedCapacityFactor,
                       int ratio, int maxDelayedQueuesPerThread, int delayedQueueRatio) {
        interval = max(0, ratio);
        delayedQueueInterval = max(0, delayedQueueRatio);
        if (maxCapacityPerThread <= 0) {
            this.maxCapacityPerThread = 0;
            this.maxSharedCapacityFactor = 1;
            this.maxDelayedQueuesPerThread = 0;
        } else {
            this.maxCapacityPerThread = maxCapacityPerThread;
            this.maxSharedCapacityFactor = max(1, maxSharedCapacityFactor);
            this.maxDelayedQueuesPerThread = max(0, maxDelayedQueuesPerThread);
        }
    }

}
```

关于Recycler对象池中相关的重要属性我们在上一小节已经详细介绍过了，这里只是将这些重要参数赋值于Recycler对象池中定义的对应属性上。还是那句话，大家这里只需要对这些属性有一个感性的认识即可，并不需要强行完全理解，后面我们在介绍对象池的功能实现时还会结合具体场景来介绍这些属性。

## 多线程获取对象无锁化实现







![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729950279979-8cf448aa-3f9a-4c05-862c-dd1eabd7ec06.webp)

在介绍 Netty 对象池多线程获取对象的设计时，我们提到为了避免多线程并发获取对象时引入的同步开销，Netty 采用了类似 **TLAB**（Thread Local Allocation Buffer）分配内存的思想，为每个线程分配了一个独立的 **Stack** 结构。池化对象就存储在这个 **Stack** 结构中。

当线程需要从对象池中获取对象时，**Recycler** 会直接从该线程对应的 **Stack** 结构中获取池化对象。由于各个线程独立运行，因此不会产生任何同步开销，这大大提高了对象获取的效率和性能。

```java
//threadlocal保存每个线程对应的 stack结构
private final FastThreadLocal<Stack<T>> threadLocal = new FastThreadLocal<Stack<T>>() {
    @Override
    protected Stack<T> initialValue() {
        return new Stack<T>(Recycler.this, Thread.currentThread(), maxCapacityPerThread, maxSharedCapacityFactor,
                interval, maxDelayedQueuesPerThread, delayedQueueInterval);
    }
    
    ..............省略..........
};
```

对象池中采用一个 **FastThreadLocal** 类型的字段 `threadLocal` 为每个线程维护一个独立的 **Stack** 结构，从而实现多线程无锁化获取对象的目的。

**FastThreadLocal** 是 Netty 基于 JDK 的 **ThreadLocal** 进行优化的版本，具有更快的访问性能。后续笔者将专门讲解 **FastThreadLocal** 的详细实现，这里大家可以将其视为 JDK 的 **ThreadLocal**。

当线程第一次从对象池中获取对象时，会触发其对应的 **Stack** 结构的创建。这种设计确保了每个线程都能高效地管理自己的对象池，避免了锁的竞争，提高了性能。

### Stack 结构的创建

本小节将介绍对象池中 **Stack** 结构的设计实现。在前面的《5.2 Stack的设计》小节中，我们已经讨论了 **Stack** 结构中的一些核心属性，包括数组栈、**WeakOrderQueue** 链表的 **Head** 指针、**Prev** 指针和 **Cursor** 指针。

在本小节中，我将向大家介绍 **Stack** 结构中的其他剩余属性。通过这一部分的介绍，相信大家对 **Stack** 的设计实现将有一个整体的了解。需要强调的是，这里大家只需对这些属性有一个感性的认识，熟悉这些概念即可。后续笔者还会结合具体场景进行详细讲解。

```java
private static final class Stack<T> {

    // 创建线程保存池化对象的stack结构所属对象池recycler实例
    final Recycler<T> parent;

    //用弱引用来关联当前stack对应的创建线程 因为用户可能在某个地方引用了defaultHandler -> stack -> thread，可能存在这个引用链
    //当创建线程死掉之后 可能因为这个引用链的存在而导致thread无法被回收掉
    final WeakReference<Thread> threadRef;

    //所有回收线程能够帮助当前创建线程回收对象的总容量
    final AtomicInteger availableSharedCapacity;

    //当前Stack对应的创建线程作为其他创建线程的回收线程时可以帮助多少个线程回收其池化对象
    private final int maxDelayedQueues;

    //当前创建线程对应的stack结构中的最大容量。 默认4096个对象
    private final int maxCapacity;

    //当前创建线程回收对象时的回收比例
    private final int interval;

    //当前创建线程作为其他线程的回收线程时回收其他线程的池化对象比例
    private final int delayedQueueInterval;

    // 当前Stack中的数组栈 默认初始容量256，最大容量为4096
    DefaultHandle<?>[] elements;

    //数组栈 栈顶指针
    int size;

    //回收对象计数 与 interval配合 实现只回收一定比例的池化对象
    private int handleRecycleCount;

    //多线程回收的设计，核心还是无锁化，避免多线程回收相互竞争
    //Stack结构中的WeakOrderQueue链表
    private WeakOrderQueue cursor, prev;
    private volatile WeakOrderQueue head;
}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729950565629-db18961e-5d93-4f6d-93aa-ea10b53e4705.webp)

以下是对 **Stack** 结构中剩余属性的详细介绍：

- **Recycler<T> parent**：该属性表示 **Stack** 所属的 **Recycler** 对象池实例。由于一个对象池可以被多个线程访问并获取对象，因此一个对象池对应多个 **Stack**，每个 **Stack** 的 `parent` 属性指向所属的 **Recycler** 实例。例如，图中的 `stack1`、`stack2`、`stack3` 和 `stack4` 中的 `parent` 属性均指向同一个 **Recycler** 对象池实例。
- **WeakReference<Thread> threadRef**：**Stack** 通过弱引用方式引用其对应的创建线程。使用弱引用的原因是因为对象池设计中存在如下引用关系：池化对象 → **DefaultHandler** → **Stack** → `threadRef`。池化对象是暴露给用户的，如果用户在某个地方持有了池化对象的强引用并忘记清理，而 **Stack** 又持有创建线程的强引用，那么当创建线程死掉后，由于这个强引用链的存在，创建线程将无法被 **GC** 回收。
- **AtomicInteger availableSharedCapacity**：该属性表示当前创建线程对应的所有回收线程可以帮助该创建线程回收的对象总量。例如，图中的 `thread2`、`thread3` 和 `thread4` 这三个回收线程总共可以帮助 `thread1` 回收对象的总量。`availableSharedCapacity` 在多个回收线程中是共享的，当回收线程每回收一个对象时，它的值会减1。当该值小于 `LINK_CAPACITY`（回收线程对应 **WeakOrderQueue** 节点的最小存储单元）时，该回收线程将无法继续为该 **Stack** 回收对象。该值的计算公式为：`max(maxCapacity / maxSharedCapacityFactor, LINK_CAPACITY)`。

当创建线程从 **Stack** 结构中的 **WeakOrderQueue** 链表中转移待回收对象到数组栈中后，`availableSharedCapacity` 的值会相应增加。换句话说，这个值用来指示回收线程还能继续回收多少对象，以控制回收线程回收对象的总体容量。

- **int maxDelayedQueues**：该属性定义了一个线程对于对象池来说，作为回收线程时最多可以为多少个创建线程回收对象。默认值为 `CPU * 2`。例如，图中的 `thread2` 作为回收线程可以同时帮助 `thread1`、`thread3` 和 `thread4` 回收对象，那么 `maxDelayedQueues` 的值就是 `3`。
- **int maxCapacity**：该属性定义当前 **Stack** 结构中数组栈的最大容量，默认为 `4096`。
- **int interval**：创建线程的回收比例，默认值为 `8`。
- **int delayedQueueInterval**：创建线程作为回收线程时的回收比例，默认值为 `8`。
- **DefaultHandle<?>[] elements**：这是我们前面提到的 **Stack** 结构中的数组栈，用于存放对象池中的池化对象。当线程从对象池中获取对象时，正是从这里获取的。
- **int size**：表示数组栈中的栈顶指针。
- **int handleRecycleCount**：回收对象计数。与 `interval` 配合使用以控制回收对象的比例。该计数从 `0` 开始，每遇到一个回收对象就加1，同时丢弃该对象。直到 `handleRecycleCount == interval` 时才会回收对象，然后归零。也就是说，前面提到的“每创建 **8** 个对象才回收 **1** 个”的机制，从而避免 **Stack** 不可控地迅速增长。
- **WeakOrderQueue cursor, prev, head**：这三个指针用于 **WeakOrderQueue** 链表中的头结点指针（`head`）、当前节点指针（`cursor`）和前一个节点指针（`prev`，用于删除节点），实现多线程无锁化回收。

介绍完Stack结构中的这些重要属性，创建的过程就很简单了。就是利用前边介绍过的已经初始化好的Recycler属性对Stack结构中的这些属性进行赋值。

```java
private final FastThreadLocal<Stack<T>> threadLocal = new FastThreadLocal<Stack<T>>() {
    @Override
    protected Stack<T> initialValue() {
        return new Stack<T>(Recycler.this, Thread.currentThread(), maxCapacityPerThread, maxSharedCapacityFactor,
                interval, maxDelayedQueuesPerThread, delayedQueueInterval);
    }

  ..............省略............
}
Stack(Recycler<T> parent, Thread thread, int maxCapacity, int maxSharedCapacityFactor,
      int interval, int maxDelayedQueues, int delayedQueueInterval) {
    this.parent = parent;
    threadRef = new WeakReference<Thread>(thread);
    this.maxCapacity = maxCapacity;
    availableSharedCapacity = new AtomicInteger(max(maxCapacity / maxSharedCapacityFactor, LINK_CAPACITY));
    elements = new DefaultHandle[min(INITIAL_CAPACITY, maxCapacity)];
    this.interval = interval;
    this.delayedQueueInterval = delayedQueueInterval;
    handleRecycleCount = interval; 
    this.maxDelayedQueues = maxDelayedQueues;
}
```

### 从对象池中获取对象

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729950776409-1cb12a25-a818-4ea4-948a-f6829b68fe90.webp)

```java
public abstract class Recycler<T> {
      //一个空的Handler,表示该对象不会被池化
     private static final Handle NOOP_HANDLE = new Handle() {
        @Override
        public void recycle(Object object) {
            // NOOP
        }
    };

    public final T get() {
        //如果对象池容量为0，则立马新创建一个对象返回，但是该对象不会回收进对象池
        if (maxCapacityPerThread == 0) {
            return newObject((Handle<T>) NOOP_HANDLE);
        }
        //获取当前线程 保存池化对象的stack
        Stack<T> stack = threadLocal.get();
        //从stack中pop出对象，handler是池化对象在对象池中的模型，包装了一些池化对象的回收信息和回收状态
        DefaultHandle<T> handle = stack.pop();
        //如果当前线程的stack中没有池化对象 则直接创建对象
        if (handle == null) {
            //初始化的handler对象recycleId和lastRecyclerId均为0
            handle = stack.newHandle();
            //newObject为对象池recycler的抽象方法，由使用者初始化内存池的时候 匿名提供
            handle.value = newObject(handle);
        }
        return (T) handle.value;
    }

}
```

Recycler对外表现为一个整体的对象池，但其内部按照线程维度进行对象池化。每个线程所池化的对象保存在对应的Stack结构中。

1. 当对象池的最大容量 `maxCapacityPerThread == 0` 时，对象池会立即创建一个对象，并将一个空的Handler传递给该对象。这表示该对象在使用完毕后不会被回收进对象池中。
2. 接下来，从 `ThreadLocal` 中获取当前线程对应的Stack，然后从Stack结构中的数组栈中弹出栈顶对象的 `DefaultHandler`。
3. 如果弹出的 `DefaultHandler` 为空，说明当前Stack中并没有可回收的池化对象。在这种情况下，直接创建一个新的 `DefaultHandler` 和一个新的对象，然后将 `DefaultHandler` 传入新创建的对象中，并用 `DefaultHandler` 包裹新创建的对象。这样，池化对象就与 `DefaultHandler` 关联起来了。

```java
static final class Entry {

     private static final ObjectPool<Entry> RECYCLER = ObjectPool.newPool(new ObjectCreator<Entry>() {
            @Override
            public Entry newObject(Handle<Entry> handle) {
                return new Entry(handle);
            }
        });

     private Entry(Handle<Entry> handle) {
            this.handle = handle;
     }
}
```

### DefaultHandler

前边我们在介绍对象池的设计原理时提到，池化对象在对象池中的存储模型为 Handler。

```java
public abstract class ObjectPool<T> {

    public interface Handle<T> {
        void recycle(T self);
    }

}
```

在Recycler对象池中，默认实现是 `DefaultHandler`。`DefaultHandler` 包裹了池化对象以及池化对象在对象池中的一些相关信息，例如：池化对象的回收信息和回收状态。

从结构设计角度来看，池化对象隶属于其创建线程对应的Stack结构。由于这种结构关系，池化对象的 `DefaultHandler` 应由对应的Stack来进行创建。

```java
private static final class Stack<T> {

    DefaultHandle<T> newHandle() {
        return new DefaultHandle<T>(this);
    }
}
```

我们来看下 DefaultHandler 的具体结构：

```java
private static final class DefaultHandle<T> implements Handle<T> {
    //用于标识最近被哪个线程回收，被回收之前均是0
    int lastRecycledId;
    //用于标识最终被哪个线程回收，在没被回收前是0
    int recycleId;

    //是否已经被回收
    boolean hasBeenRecycled;
    //强引用关联创建handler的stack
    Stack<?> stack;
    //池化对象
    Object value;

    DefaultHandle(Stack<?> stack) {
        this.stack = stack;
    }

    @Override
    public void recycle(Object object) {

      ...................省略.............
    }
}
```

`DefaultHandler` 属性的第一部分信息是池化对象在对象池中的回收信息，包括以下字段：

- **int lastRecycledId**：用于标识最近被哪个线程回收，回收之前均为 0。
- **int recycleId**：用于标识最终被哪个线程回收，在未被回收前为 0。
- **boolean hasBeenRecycled**：表示该池化对象是否已经被回收至其创建线程对应的Stack中。

此时可能会有疑问：为什么池化对象的回收需要区分最近回收和最终回收呢？

对象池中的池化对象回收可以分为两种情况：

1. **由创建线程直接进行回收**：这种回收情况是一种一步到位的过程，直接回收至创建线程对应的Stack中。在这种情况下，不分阶段，`recycleId = lastRecycledId = OWN_THREAD_ID`。
2. **由回收线程帮助回收**：这种回收情况需要分步进行。首先，由回收线程将池化对象暂时存储在其创建线程对应Stack中的 `WeakOrderQueue` 链表中。此时，并没有完成真正的对象回收。此时，`recycleId = 0`，`lastRecycledId = 回收线程Id（WeakOrderQueue#id）`。当创建线程将 `WeakOrderQueue` 链表中的待回收对象转移至Stack结构中的数组栈后，池化对象才算真正完成了回收动作，此时 `recycleId = lastRecycledId = 回收线程Id（WeakOrderQueue#id）`。

这两个字段 `lastRecycledId` 和 `recycleId` 主要用于标记池化对象所处的回收阶段，以及在这些回收阶段具体被哪个线程进行回收。

最后两个属性较为简单易懂，一个是 `Object value` 用于包裹真正的池化对象，另一个是 `Stack<?> stack` 用于强引用关联池化对象的Handler所属的Stack结构。

回忆一下，在介绍Stack结构时提到，Stack中持有其对应创建线程的弱引用。笔者在解释为什么持有创建线程的弱引用时，提到过这样的引用链关系：池化对象 -> `DefaultHandler` -> Stack -> `threadRef`。大家明白了吗？

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729951296622-377486c8-623b-4d6e-aa32-5c171d8e34f6.webp)



```java
static final class Entry {
    //池化对象Entry强引用它的DefaultHandler
    private  Handle<Entry> handle;
  
}


private static final class DefaultHandle<T> implements Handle<T> {
    // DefaultHandler强引用其所属的Stack
    Stack<?> stack;

}

private static final class Stack<T> {
    // Stack弱引用其对应的创建线程
    final WeakReference<Thread> threadRef;

}
```

### 从Stack中获取池化对象

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729951433278-96154099-950c-4a04-abce-d655d1bf0cad.webp)

```java
DefaultHandle<T> pop() {
    //普通出栈操作，从栈顶弹出一个回收对象
    int size = this.size;
    if (size == 0) {
        //如果当前线程所属stack已经没有对象可用，则遍历stack中的weakOrderQueue链表（其他线程帮助回收的对象存放在这里）将这些待回收对象回收进stack
        if (!scavenge()) {
            return null;
        }
        size = this.size;
        if (size <= 0) {
            // 如果WeakOrderQueue链表中也没有待回收对象可转移
            // 直接返回null 新创建一个对象
            return null;
        }
    }
    size --;
    DefaultHandle ret = elements[size];
    elements[size] = null;
    this.size = size;

    if (ret.lastRecycledId != ret.recycleId) {
        // 这种情况表示对象至少被一个线程回收了，要么是创建线程，要么是回收线程
        throw new IllegalStateException("recycled multiple times");
    }

    //对象初次创建以及回收对象再次使用时  它的 recycleId = lastRecycleId = 0
    ret.recycleId = 0;
    ret.lastRecycledId = 0;
    return ret;
}
```

这里是业务线程从对象池中真正获取池化对象的地方，通过从Stack结构中的数组栈的栈顶位置弹出池化对象。

首先，判断数组栈中是否有回收的池化对象。如果栈顶指针 `size == 0`，说明当前数组栈是空的。此时会调用 `scavenge` 方法，从Stack结构中的 `WeakOrderQueue` 链表中转移最多一个 `Link` 大小的待回收对象到数组栈中。如果 `WeakOrderQueue` 链表中也没有待回收对象，说明当前Stack结构为空，没有任何回收的池化对象，对象池直接返回 `null`，并创建一个新的池化对象返回给业务线程。

如果数组栈不为空，则将栈顶元素 `DefaultHandler` 弹出，并初始化池化对象 `DefaultHandler` 的回收信息。此时，`recycleId = lastRecycledId = 0`，表示该池化对象刚刚从对象池中取出。

`recycleId` 与 `lastRecycledId` 之间的关系可以分为以下几种情况：

1. `**recycleId = lastRecycledId = 0**`：表示池化对象刚刚被创建或刚从对象池中取出，即将被再次复用。这是池化对象的初始状态。
2. `**recycleId = lastRecycledId != 0**`：表示当前池化对象已经被回收至对应Stack结构里的数组栈中，可以直接被取出复用。这可能是由于其创建线程直接回收，也可能是回收线程回收。
3. `**recycleId != lastRecycledId**`：表示当前池化对象处于半回收状态。池化对象已经被业务线程处理完毕，并被回收线程回收至对应的 `WeakOrderQueue` 节点中，等待创建线程将其最终转移至Stack结构中的数组栈中。

### 转移回收线程回收的对象到Stack中

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729951686153-a901b3ad-5cae-4668-a756-561344a92708.webp)

通过前面介绍的Stack结构的设计原理，我们了解到，对象池中池化对象的回收存储分为两个部分：

1. **直接回收**：池化对象直接由创建线程回收，存储在创建线程对应Stack结构中的数组栈中。
2. **间接回收**：池化对象被回收线程回收，暂时存储在创建线程对应Stack结构中的 `WeakOrderQueue` 链表中。每个回收线程对应一个 `WeakOrderQueue` 节点。

当Stack结构中的数组栈为空时，创建线程会遍历 `WeakOrderQueue` 链表，从中将回收线程为其回收的对象转移至数组栈中。这种多线程回收对象的设计是无锁的。

这个转移的动作是由 `scavenge` 方法来完成的。

```java
private boolean scavenge() {
    //从其他线程回收的weakOrderQueue里 转移 待回收对像 到当前线程的stack中
    if (scavengeSome()) {
        return true;
    }

    // 如果weakOrderQueue中没有待回收对象可转移，那么就重置stack中的cursor.prev
    // 因为在扫描weakOrderQueue链表的过程中，cursor已经发生变化了
    prev = null;
    cursor = head;
    return false;
}
```

`scavengeSome()` 执行具体的转移逻辑。如果 `WeakOrderQueue` 链表中还有待回收对象并成功转移，则返回 `true`。如果 `WeakOrderQueue` 链表为空，没有任何待回收对象可转移，则重置链表相关的指针：`cursor` 重新指向 `head` 节点，`prev` 指向 `null`。这是因为在遍历 `WeakOrderQueue` 链表搜寻可转移对象时，`cursor` 指针已经发生变化，因此需要进行重置。  

### 转移回收对象

接下来，创建线程将开始遍历Stack结构中的 `WeakOrderQueue` 链表，将其中存储的回收线程回收的对象转移到数组栈中。

为了让大家更清晰地理解遍历 `WeakOrderQueue` 链表的过程，我们先来了解一下Stack中 `WeakOrderQueue` 链表的状态结构，如下图所示：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729951913552-b833d2b9-2786-4bb7-85c3-b568c15d5f81.webp)

在Stack结构刚刚创建的初始状态时，`WeakOrderQueue` 链表是空的，因此 `prev = head = cursor = null`。

随后，当回收线程回收对象时，会将自己对应的 `WeakOrderQueue` 节点加入链表中。需要注意的是，`WeakOrderQueue` 节点的插入始终是在链表的头节点进行。

后续我们将在讲解多线程回收对象时详细讨论 `WeakOrderQueue` 链表的操作，此时大家只需理解链表的状态结构即可。

- `**head**` **指针**始终指向链表的头节点。
- `**cursor**` **指针**指向当前遍历的节点。在没有开始遍历链表前，`cursor` 指针指向头节点，表示从头节点开始遍历。
- `**prev**` **指针**指向 `cursor` 前一个节点。当当前遍历节点为头节点时，`prev` 指针指向空。

理解了 `WeakOrderQueue` 链表的状态结构后，我们来看一下链表的遍历转移过程的逻辑：

```java
private boolean scavengeSome() {
    WeakOrderQueue prev;
    //获取当前线程stack 的weakOrderQueue链表指针（本次扫描起始节点）
    WeakOrderQueue cursor = this.cursor;
    //在stack初始化完成后，cursor，prev,head等指针全部是null，这里如果cursor == null 意味着当前stack第一次开始扫描weakOrderQueue链表
    if (cursor == null) {
        prev = null;
        cursor = head;
        if (cursor == null) {
            //说明目前weakOrderQueue链表里还没有节点，并没有其他线程帮助回收的池化对象
            return false;
        }
    } else {
        //获取prev指针，用于操作链表（删除当前cursor节点）
        prev = this.prev;
    }

    boolean success = false;
    //循环遍历weakOrderQueue链表 转移待回收对象
    do {
        //将weakOrderQueue链表中当前节点中包含的待回收对象，转移到当前stack中，一次转移一个link
        if (cursor.transfer(this)) {
            success = true;
            break;
        }
        //如果当前cursor节点没有待回收对象可转移，那么就继续遍历链表获取下一个weakOrderQueue节点
        WeakOrderQueue next = cursor.getNext();
        //如果当前weakOrderQueue对应的回收线程已经挂掉了，则
        if (cursor.get() == null) {
            // 判断当前weakOrderQueue节点是否还有可回收对象
            if (cursor.hasFinalData()) {
                //回收weakOrderQueue中最后一点可回收对象，因为对应的回收线程已经死掉了，这个weakOrderQueue不会再有任何对象了
                for (;;) {

                    if (cursor.transfer(this)) {
                        success = true;
                    } else {
                        break;
                    }
                }
            }

            //回收线程以死，对应的weaoOrderQueue节点中的最后一点待回收对象也已经回收完毕，就需要将当前节点从链表中删除。unlink当前cursor节点
            //这里需要注意的是，netty永远不会删除第一个节点，因为更新头结点是一个同步方法，避免更新头结点而导致的竞争开销
            // prev == null 说明当前cursor节点是头结点。不用unlink，如果不是头结点 就将其从链表中删除，因为这个节点不会再有线程来收集池化对象了
            if (prev != null) {
                //确保当前weakOrderQueue节点在被GC之前，我们已经回收掉它所有的占用空间
                cursor.reclaimAllSpaceAndUnlink();
                //利用prev指针删除cursor节点
                prev.setNext(next);
            }
        } else {
            prev = cursor;
        }
        //向后移动prev,cursor指针继续遍历weakOrderQueue链表
        cursor = next;

    } while (cursor != null && !success);

    this.prev = prev;
    this.cursor = cursor;
    return success;
}
```

1. **初始化遍历**
   在开始遍历 `WeakOrderQueue` 链表之前，首先需要检查 `cursor` 指针是否为空。如果为空，说明当前 `Stack` 是第一次开始遍历 `WeakOrderQueue` 链表。接着，将 `cursor` 指针指向 `head` 指针。如果 `head` 指针为空，说明当前 `WeakOrderQueue` 链表是空的，此时没有任何回收线程在回收对象。如果 `head` 指针不为空，则从 `head` 指针指向的头节点开始遍历 `WeakOrderQueue` 链表。
2. **转移对象**
   从 `cursor` 指针指向的当前遍历节点开始，将当前 `WeakOrderQueue` 节点中存储的待回收对象转移到 `Stack` 结构中的数组栈中。一次最多转移一个 `Link` 大小的对象。转移成功后退出。如果当前 `WeakOrderQueue` 节点没有待回收对象可被转移，则转移失败，继续遍历下一个 `WeakOrderQueue` 节点。
3. **无锁化设计**
   为了实现多线程的无锁化回收对象，一个回收线程对应一个 `WeakOrderQueue` 节点，在 `WeakOrderQueue` 节点中持有对应回收线程的弱引用。这样可以确保当回收线程挂掉时，该线程能够及时被 GC 回收。如果 `cursor.get() == null`，则说明当前 `WeakOrderQueue` 节点对应的回收线程已经挂掉。在这种情况下，如果当前节点还有待回收对象，则需要将节点中的所有待回收对象全部转移至 `Stack` 中的数组栈中。这里需要注意的是，要转移节点所有的待回收对象，而不是只转移一个 `Link`，因为对应的回收线程已经挂掉，后续将不再帮助创建线程回收对象，因此要清理其对应的 `WeakOrderQueue` 节点。
4. **删除节点**
   清理完已经挂掉的回收线程对应的 `WeakOrderQueue` 节点后，需要将该节点从 `Stack` 结构中的 `WeakOrderQueue` 链表中删除，以保证被清理后的 `WeakOrderQueue` 节点可以被 GC 回收。在删除节点之前，需要通过 `cursor.reclaimAllSpaceAndUnlink()` 方法释放回收线程回收对象的 `availableSharedCapacity` 容量。释放的容量大小为被删除 `WeakOrderQueue` 节点中存储的待回收对象容量。

需要注意的是，Netty 不会对 `WeakOrderQueue` 链表的头节点进行删除。如果 `prev == null`，说明当前节点是头节点，即使对应的回收线程已经挂掉了，但在本次遍历中不会对其进行删除。因为操作链表头节点的方法是一个同步方法，Netty 为了避免不必要的同步开销，因此选择不删除头节点。

以上是创建线程遍历 `WeakOrderQueue` 链表以转移回收对象的处理逻辑。如果本次遍历的当前节点中没有对象可转移，那么将继续从下一个节点开始遍历。循环执行转移逻辑，直到遍历完链表或中途成功转移。退出循环时需要更新 `cursor` 指针，记录当前遍历到的节点。  



**这里大家可能会有两个问题：**

- **如果头结点对应的回收线程已经挂掉，这个头结点不在本次遍历中删除，那么会在什么时候被删除呢？**

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729952428509-14f4d28d-6530-4426-9615-3ba7330f63e2.webp)

首先，当回收线程第一次开始帮助创建线程回收对象时，会将自己对应的 `WeakOrderQueue` 节点插入到创建线程对应的 Stack 结构中的 `WeakOrderQueue` 链表的头结点位置。节点始终在链表的头结点位置插入。

如图所示，当本次遍历发现头结点对应的回收线程 `thread4` 已经挂掉后，清理完头结点中存储的待回收对象后，让其继续呆在链表中，并不着急将其删除。随后，`cursor` 指针指向 `thread3` 对应的节点，下一次遍历就会从 `thread3` 对应的节点开始。

当有一个新的回收线程 `thread5` 加入后，此时 `thread5` 对应的 `WeakOrderQueue` 节点变成了链表中的头结点。当经过多次遍历之后，`cursor` 指针最终会再次指向死亡线程 `thread4` 对应的节点，此时将再次进入 `cursor.get() == null` 的处理逻辑。此时 `thread4` 对应的节点已经不是头结点了，因此在这次遍历中就将该节点从链表中删除。

这就是多线程并发代码与单线程代码设计上的不同。在多线程程序设计中，我们一定要时刻警惕同步操作的开销，能避免就要尽量避免。

- **操作WeakOrderQueue链表的头结点为什么是同步方法呢？**

在对象回收的过程中，每个回收线程对应一个 `WeakOrderQueue` 节点。当回收线程第一次为创建线程回收对象时，都会创建一个新的 `WeakOrderQueue` 节点，并将其插入到创建线程对应 `Stack` 中的 `WeakOrderQueue` 链表的头结点位置。

在多线程回收场景下，可能会有多个回收线程同时向创建线程的 `Stack` 中的 `WeakOrderQueue` 链表的头结点插入它们对应的节点。

因此，对链表头结点的插入操作必须进行同步处理。节点同步插入到链表头结点后，此后的回收操作即可无锁化执行。虽然在节点的初次插入时会有少许同步开销，但这是不可避免的。

```java
//整个recycler对象池唯一的一个同步方法，而且同步块非常小，逻辑简单，执行迅速
synchronized void setHead(WeakOrderQueue queue) {
    //始终在weakOrderQueue链表头结点插入新的节点
    queue.setNext(head);
    head = queue;
}
```

纵观整个Recycler的设计实现，这个方法是唯一一个同步的方法，而且同步块非常的短，里面的逻辑非常简单。

在多线程程序设计中，如果遇到无法避免的同步情况，那么也必须使同步块内的代码逻辑尽量简单。

## WeakOrderQueue的设计实现

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729952741783-377af6a1-5828-43f6-80ff-60a6f9401c66.webp)

在介绍 `WeakOrderQueue` 结构设计原理时提到，虽然该结构名称后缀是 “Queue”，但实际上是一个链表。链表中的元素类型为 `Link`，并采用头尾双指针管理。

- 头指针 `Head`：始终指向第一个尚未被完全转移的 `Link` 节点。当一个 `Link` 中的待回收对象被全部转移完毕后，`Head` 指针会移动到下一个节点，但该 `Link` 节点并不会从链表中删除。
- 尾指针 `Tail`：指向链表中的最后一个 `Link` 节点，新的节点插入时从链表的尾部插入。

这种设计确保了回收对象可以按顺序高效地转移，同时避免频繁地插入或删除 `Link` 节点。

### Link结构

```java
private static final class WeakOrderQueue extends WeakReference<Thread> {

    // link结构是用于真正存储待回收对象的结构，继承AtomicInteger 本身可以用来当做writeindex使用
    static final class Link extends AtomicInteger {
        //数组用来存储待回收对象，容量为16
        final DefaultHandle<?>[] elements = new DefaultHandle[LINK_CAPACITY];

        int readIndex;
        //weakOrderQueue中的存储结构时由link结构节点元素组成的链表结构
        Link next;
    }
}
```

首先从 `WeakOrderQueue` 的继承结构来看，它继承自 `WeakReference<Thread>`，表示该结构持有一个线程的弱引用。一个回收线程对应一个 `WeakOrderQueue` 节点，这样设计是为了在回收线程挂掉时，节点可以被 GC 自动回收。

- `**DefaultHandle<?>[] elements**`：`Link` 结构中包含一个大小为 `LINK_CAPACITY`（默认为 16）的 `DefaultHandle` 数组，用于存储回收线程回收的对象。
- `**int readIndex**`：`readIndex` 用于创建线程在转移 `Link` 节点中的待回收对象时，记录读取位置。由于该变量仅由创建线程使用，不需要保证原子性和可见性，因此直接使用普通的 `int` 类型即可。
- `**AtomicInteger writeIndex**`：`writeIndex` 记录当前节点中的写入位置。由于回收线程在向 `Link` 节点添加回收对象时需要更新 `writeIndex`，而创建线程在转移对象时也需要读取 `writeIndex`，因此需要保证线程安全性，采用 `AtomicInteger` 类型存储。
- `**Link next**`：`next` 指针用于链接链表中的下一个 `Link` 节点，形成链表结构。

### Head结构

```java
// weakOrderQueue内部link链表的头结点
private static final class Head {
    //所有回收线程能够帮助创建线程回收对象的总容量 reserveSpaceForLink方法中会多线程操作该字段
    //用于指示当前回收线程是否继续为创建线程回收对象，所有回收线程都可以看到，这个值是所有回收线程共享的。以便可以保证所有回收线程回收的对象总量不能超过availableSharedCapacity
    private final AtomicInteger availableSharedCapacity;
    //link链表的头结点
    Link link;

    Head(AtomicInteger availableSharedCapacity) {
        this.availableSharedCapacity = availableSharedCapacity;
    }

    void reclaimAllSpaceAndUnlink() {
            ....回收head节点的所有空间，并从链表中删除head节点，head指针指向下一节点....
    }

    private void reclaimSpace(int space) {
        //所有回收线程都可以看到，这个值是所有回收线程共享的。以便可以保证所有回收线程回收的对象总量不能超过availableSharedCapacity
        availableSharedCapacity.addAndGet(space);
    }

    //参数link为新的head节点，当前head指针指向的节点已经被回收完毕
    void relink(Link link) {
          ...回收当前头结点的容量，更新head节点为指定的Link节点...
    }

    Link newLink() {
          ....创建新的Link节点...
    }

    //此处目的是为接下来要创建的link预留空间容量
    static boolean reserveSpaceForLink(AtomicInteger availableSharedCapacity) {               
          ...在创建新的Link节点之前需要调用该方法预订容量空间...
    }
}
```

从代码结构上来看，`Head` 的设计不仅仅是作为头结点指针，它还封装了许多链表操作和回收逻辑。

- `**AtomicInteger availableSharedCapacity**`：这个字段用于表示所有回收线程可以帮助创建线程回收的总对象数量，是一个多线程共享的变量。它限制了所有回收线程的总回收对象量。每创建一个 `Link` 节点，该值减少一个 `LINK_CAPACITY`；每释放一个 `Link` 节点时，该值增加一个 `LINK_CAPACITY`。
- `**Link link**`：`Head` 结构中封装的 `Link` 链表的头结点，用于存储待回收的对象链表。

至于 `Head` 中封装的具体逻辑处理方法，等介绍到具体应用场景时会展开详细说明。这里只需对 `Head` 的大体结构有一个模糊的了解，帮助形成初步印象即可。

### WeakOrderQueue 中的重要属性

```java
private static final class WeakOrderQueue extends WeakReference<Thread> {

    //link链表的头结点，head指针始终指向第一个未被转移完毕的LinK节点
    private final Head head;
    //尾结点
    private Link tail;
    //站在stack的视角中，stack中包含一个weakOrderQueue的链表，每个回收线程为当前stack回收的对象存放在回收线程对应的weakOrderQueue中
    //这样通过stack中的这个weakOrderQueue链表，就可以找到其他线程为该创建线程回收的对象
    private WeakOrderQueue next;
    //回收线程回收Id,每个weakOrderQueue分配一个，同一个stack下的一个回收线程对应一个weakOrderQueue节点
    private final int id = ID_GENERATOR.getAndIncrement();
    //回收线程回收比例 默认是8
    private final int interval;
    //回收线程回收计数 回收1/8的对象
    private int handleRecycleCount;

}
```

- `**Head head**`：指向 `WeakOrderQueue` 中 `Link` 链表的头结点，用于访问待转移的对象。
- `**Link tail**`：指向 `Link` 链表中的尾结点，新的 `Link` 节点会添加到尾部。
- `**WeakOrderQueue next**`：从 `Stack` 结构的视角来看，`Stack` 包含一个 `WeakOrderQueue` 链表，用于存放由回收线程回收的池化对象。`next` 字段是 `WeakOrderQueue` 节点的指针，指向下一个回收线程对应的 `WeakOrderQueue` 节点。
- `**int id**`：代表回收线程的唯一标识。在同一个 `Stack` 结构下，不同的回收线程有不同的 `id`。
- `**int interval**`：回收线程的回收频率，默认设置为 1/8，即每 8 个池化对象中只回收 1 个。
- `**int handleRecycleCount**`：用于记录回收对象的计数，控制回收频率。

### WeakOrderQueue 结构的创建

```java
private static final class WeakOrderQueue extends WeakReference<Thread> {
    //为了使stack能够被GC,这里不会持有其所属stack的引用
    private WeakOrderQueue(Stack<?> stack, Thread thread) {
        //weakOrderQueue持有对应回收线程的弱引用
        super(thread);
        //创建尾结点
        tail = new Link();

        // 创建头结点  availableSharedCapacity = maxCapacity / maxSharedCapacityFactor
        head = new Head(stack.availableSharedCapacity);
        head.link = tail;
        interval = stack.delayedQueueInterval;
        handleRecycleCount = interval; 
    }
}
```

在创建 `WeakOrderQueue` 结构时，会首先调用父类 `WeakReference<Thread>` 的构造方法，持有当前回收线程的弱引用。接着，会创建一个新的 `Link` 节点，并让 `head` 和 `tail` 指针同时指向这个节点。

然后，`WeakOrderQueue` 的相关属性会使用创建线程对应 `Stack` 中的属性进行初始化。

你可能会问，既然使用了 `Stack` 的属性来初始化 `WeakOrderQueue`，为什么不直接让 `WeakOrderQueue` 持有 `Stack` 的引用呢？

这是为了避免内存泄露。因为一个回收线程对应一个 `WeakOrderQueue` 节点，当回收线程结束时，需要清理 `WeakOrderQueue` 节点并将其从 `Stack` 的 `WeakOrderQueue` 链表中移除，以便该节点能被 GC 回收。如果 `WeakOrderQueue` 持有 `Stack` 的引用，而 `Stack` 所属的创建线程又已经挂掉，这将导致 `Stack` 无法被 GC 回收，造成内存泄露。

因此，在设计中，我们仅用 `Stack` 的属性初始化 `WeakOrderQueue` 的相关属性，而 `WeakOrderQueue` 本身不持有 `Stack` 的引用。

这种设计原则在复杂程序结构中尤为重要，以确保对象之间的引用关系保持清晰，从而防止内存泄露。

### 从 WeakOrderQueue 中转移回收对象

`WeakOrderQueue` 的 `transfer` 方法用于将当前 `WeakOrderQueue` 节点中的待回收对象转移到创建线程对应的 `Stack` 中。

- **遍历链表的头结点**：在开始转移时，`transfer` 方法会从 `WeakOrderQueue` 中的 `Link` 链表头结点开始。如果头结点中还有未被转移的对象，则会将这些剩余对象转移至 `Stack` 中。
- **转移数量限制**：每次转移最多将一个 `LINK_CAPACITY` 大小的对象块转移到 `Stack`，即便部分对象成功转移，`transfer` 方法也会立即返回 `true` 表示成功。
- **更新** `**head**` **指针**：如果头结点的对象已全部转移完毕，`head` 指针会更新为下一个 `Link` 节点，以便继续转移后续节点中的对象。每次调用 `transfer` 方法，创建线程仅会转移一个完整的 `Link` 节点。
- **返回状态**：如果 `Link` 链表中没有对象可以转移，则 `transfer` 方法返回 `false`，表示没有成功转移任何对象。

由于 `transfer` 方法较为复杂，下面我们可以按这些逻辑步骤逐步分析其具体实现。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729953108282-f8b828c2-baf0-45cb-977a-06d09704b570.webp)

#### 判断头结点中的待回收对象是否转移完毕

```java
//获取当前weakOrderQueue节点中的link链表头结点
Link head = this.head.link;
//头结点为null说明还没有待回收对象
if (head == null) {
    return false;
}

//如果头结点中的待回收对象已经被转移完毕
if (head.readIndex == LINK_CAPACITY) {
    //判断是否有后续Link节点
    if (head.next == null) {
        //整个link链表没有待回收对象了已经
        return false;
    }
    head = head.next;
    //当前Head节点已经被转移完毕，head指针向后移动，head指针始终指向第一个未被转移完毕的LinK节点
    this.head.relink(head);
}
```

在 `transfer` 方法中，首先会从 `Link` 链表的头结点开始进行对象转移，具体逻辑如下：

1. **检查头结点是否为空**：

- - 如果 `head == null`，则表明 `Link` 链表中没有任何节点或对象可以转移，直接返回 `false`，无需进一步处理。

1. **检查头结点的转移状态**：

- - 使用 `head.readIndex == LINK_CAPACITY` 来判断当前头结点中的对象是否已全部转移完毕。
  - 如果当前头结点中的对象已经全部转移完毕，则更新 `head` 指针指向下一个节点，即 `head = head.next`。这样，`head` 就会指向链表中的下一个 `Link` 节点。

1. **链表尾部检查**：

- - 如果此时 `head` 指针指向 `null`（即 `Link` 链表已经没有后续节点可供转移），则直接返回 `false`，表示没有对象成功转移。

通过这种方式，`transfer` 方法逐步遍历并转移 `Link` 链表中的待回收对象，确保对象按需、逐个批次地转移到 `Stack` 中。

```java
private static final class Head {

    //参数link为新的head节点，当前head指针指向的节点已经被回收完毕
    void relink(Link link) {
        //更新availableSharedCapacity，因为当前link节点中的待回收对象已经被转移完毕，所以需要增加availableSharedCapacity的值
        reclaimSpace(LINK_CAPACITY);
        //head指针指向新的头结点（第一个未被回收完毕的link节点）
        this.link = link;
    }
    private void reclaimSpace(int space) {
        //所有回收线程都可以看到，这个值是所有回收线程共享的。以便可以保证所有回收线程回收的对象总量不能超过availableSharedCapacity
        availableSharedCapacity.addAndGet(space);
    }
}
```

#### 根据本次转移对象容量评估是否应该对Stack进行扩容

此时Head节点已经校验完毕，可以执行正常的转移逻辑了。但在转移逻辑正式开始之前，还需要对本次转移对象的容量进行计算，并评估Stack的当前容量是否可以容纳的下，如果Stack的当前容量不够，则需要对Stack进行扩容。

```java
final int srcStart = head.readIndex;
//writeIndex
int srcEnd = head.get();
//该link节点可被转移的对象容量
final int srcSize = srcEnd - srcStart;
if (srcSize == 0) {
    return false;
}

// 获取创建线程stack中的当前回收对象数量总量
final int dstSize = dst.size;
// 待回收对象从weakOrderQueue中转移到stack后，stack的新容量 = 转移前stack容量 + 转移的待回收对象个数
final int expectedCapacity = dstSize + srcSize;

if (expectedCapacity > dst.elements.length) {
    //如果转移后的stack容量超过当前stack的容量 则对stack进行扩容
    final int actualCapacity = dst.increaseCapacity(expectedCapacity);
    //每次转移最多一个Link的容量
    //actualCapacity - dstSize表示扩容后的stack还有多少剩余空间
    srcEnd = min(srcStart + actualCapacity - dstSize, srcEnd);
}
```

获取 `Link` 链表头结点的 `readIndex` 和 `writeIndex`，可以通过计算 `writeIndex - readIndex` 来得出当前头结点可转移的对象数量。

Stack 的最终容量为：`expectedCapacity = stack 当前容量 + 转移对象的容量`

如果计算得出的转移后 Stack 的最终容量 `expectedCapacity` 超过了 Stack 的当前容量，则需要对 Stack 进行扩容。根据扩容后的容量，最终决定本次转移多少对象：`min(srcStart + actualCapacity - dstSize, srcEnd)`

这样做可以确保转移的对象数量不会超过 Stack 的可容纳空间。

```java
private static final class Stack<T> {

    int increaseCapacity(int expectedCapacity) {
        int newCapacity = elements.length;
        int maxCapacity = this.maxCapacity;
        do {
            newCapacity <<= 1;
        } while (newCapacity < expectedCapacity && newCapacity < maxCapacity);
        //扩容后的新容量为最接近指定容量expectedCapacity的最大2的次幂
        newCapacity = min(newCapacity, maxCapacity);
        if (newCapacity != elements.length) {
            elements = Arrays.copyOf(elements, newCapacity);
        }

        return newCapacity;
    }

}
```

如果当前Stack已经达到最大容量，无法再继续扩容：`actualCapacity - dstSize = 0`，则停止本次转移操作，直接返回`false`。

```java
if (srcStart != srcEnd) {
   .....具体的转移逻辑.......
}else {
    // The destination stack is full already.
    return false;
}
```

如果Stack的容量可以容纳头结点中存储的待转移对象，则开始正式的转移逻辑：

#### 转移回收对象

```java
//待转移对象集合 也就是Link节点中存储的元素
final DefaultHandle[] srcElems = head.elements;
//stack中存储转移对象数组
final DefaultHandle[] dstElems = dst.elements;
int newDstSize = dstSize;
for (int i = srcStart; i < srcEnd; i++) {
    DefaultHandle<?> element = srcElems[i];
    //recycleId == 0 表示对象还没有被真正的回收到stack中
    if (element.recycleId == 0) {
        //设置recycleId 表明是被哪个weakOrderQueue回收的
        element.recycleId = element.lastRecycledId;
    } else if (element.recycleId != element.lastRecycledId) {
        //既被创建线程回收 同时也被回收线程回收  回收多次 则停止转移
        throw new IllegalStateException("recycled already");
    }
    //对象转移后需要置空Link节点对应的位置
    srcElems[i] = null;

    //这里从weakOrderQueue将待回收对象真正回收到所属stack之前 需要进行回收频率控制
    if (dst.dropHandle(element)) {
        // Drop the object.
        continue;
    }
    //重新为defaultHandler设置其所属stack(初始创建该handler的线程对应的stack)
    //该defaultHandler在被回收对象回收的时候，会将其stack置为null，防止极端情况下，创建线程挂掉，对应stack无法被GC
    element.stack = dst;
    //此刻，handler才真正的被回收到所属stack中
    dstElems[newDstSize ++] = element;
}
```

将当前 `Link` 节点中的 `elements` 数组里存储的对象转移至 Stack 中的数组栈 `elements`，转移范围为 `srcStart -> srcEnd`。

在转移过程中，如果当前转移对象的 `element.recycleId` 等于 0，说明该对象尚未被真正回收至创建线程对应的 Stack 中，符合转移条件（避免多次回收）。我们之前在《9.3 从 Stack 中获取池化对象》小节中提到：

- `**recycleId = lastRecycledId = 0**`：表示池化对象刚刚被创建，或者刚刚从对象池中取出，即将被再次复用。这是池化对象的初始状态。

随后，设置回收 ID：

- `**element.recycleId = element.lastRecycledId**`：此处的 `lastRecycledId` 为当前 `WeakOrderQueue` 节点对应的回收线程 ID。

如果 `element.recycleId != element.lastRecycledId`，则表示当前对象可能已被创建线程或回收线程回收。

在转移时，如果当前转移对象已经被回收至 Stack 中，则不能被再次回收，需停止转移。

#### 控制对象回收频率

符合转移条件的对象需要经过回收频率的控制。正如前面所介绍的，仅需回收 **1/8** 的对象，也就是说，每 **8** 个对象中只回收 **1** 个。  

```java
boolean dropHandle(DefaultHandle<?> handle) {
    if (!handle.hasBeenRecycled) {
        //回收计数handleRecycleCount 初始值为8 这样可以保证创建的第一个对象可以被池化回收
        //interval控制回收频率 8个对象回收一个
        if (handleRecycleCount < interval) {
            handleRecycleCount++;
            // Drop the object.
            return true;
        }
        //回收一个对象后，回收计数清零
        handleRecycleCount = 0;
        //设置defaultHandler的回收标识为true
        handle.hasBeenRecycled = true;
    }
    return false;
}
```

当对象通过了回收频率的验证后，需要将回收对象的 `DefaultHandler` 中持有的 Stack 引用再次设置为其创建线程对应的 Stack。这是因为在回收线程将池化对象回收至 `WeakOrderQueue` 节点时，会将其 `DefaultHandler` 中对 Stack 的引用置为 `null`。因此，这里需要重置该引用。

具体而言，在回收线程回收时将回收对象的 Stack 引用置为 `null` 的原因，建议大家先进行思考，笔者将在后续多线程回收的讲解中为大家揭开这个谜底。

随后，将对象压入 Stack 结构中的数组栈中。到这里，回收线程帮助创建线程回收的对象才算真正被回收，业务线程可以直接从对象池中取出并使用这些对象。

当对象转移完毕后，需要更新当前 `Link` 节点的 `readIndex`，并更新 Stack 中数组栈的栈顶指针。如果当前 `Link` 节点已经被转移完毕，则将 `Head` 指针指向链表中的下一个节点，以便开始等待下一次的转移。

```java
if (srcEnd == LINK_CAPACITY && head.next != null) {
    // Add capacity back as the Link is GCed.
    // 如果当前Link已经被回收完毕，且link链表还有后续节点，则更新head指针
    this.head.relink(head.next);
}

//更新当前回收Link的readIndex
head.readIndex = srcEnd;
//如果没有转移任何数据 return false
if (dst.size == newDstSize) {
    return false;
}
dst.size = newDstSize;
return true;
```

到现在为止，多线程从Recycler对象池中无锁化获取对象的完整流程，笔者就为大家介绍完了，下面我们来继续剖析下多线程回收对象的场景。

## 多线程回收对象无锁化实现

之前我们在介绍池化对象的设计时，提到业务线程在使用对象的时候不应该感受到对象池的存在，所以将池化对象的回收封装在其DefaultHandler中。在业务线程使用完对象时，直接调用池化对象的recycle方法进行回收即可。

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729953741916-d890d953-639e-4203-b985-db4c4fc3284f.webp)

```java
static final class Entry {

   private  Handle<Entry> handle;

   void recycle() {
        next = null;
        bufs = null;
        buf = null;
        msg = null;
        promise = null;
        progress = 0;
        total = 0;
        pendingSize = 0;
        count = -1;
        cancelled = false;
        handle.recycle(this);
    }

}
private static final class DefaultHandle<T> implements Handle<T> {
    
    ..................省略............

    //强引用关联创建handler的stack
    Stack<?> stack;
    //池化对象
    Object value;

    @Override
    public void recycle(Object object) {
        if (object != value) {
            throw new IllegalArgumentException("object does not belong to handle");
        }

        Stack<?> stack = this.stack;
        //handler初次创建以及从对象池中获取到时 recycleId = lastRecycledId = 0（对象被回收之前）
        //创建线程回收对象后recycleId = lastRecycledId = OWN_THREAD_ID
        //回收线程回收对象后lastRecycledId = 回收线程Id,当对象被转移到stack中后 recycleId = lastRecycledId = 回收线程Id
        if (lastRecycledId != recycleId || stack == null) {
            throw new IllegalStateException("recycled already");
        }

        stack.push(this);
    }

}
```

`DefaultHandler` 中的 `recycle` 方法逻辑比较简单，唯一较难理解的地方在于判断对象是否已经被回收的 `if` 条件语句。

- `**lastRecycledId != recycleId**`：此时对象的状态处于已经被回收线程回收至对应 `WeakOrderQueue` 节点的半回收状态，但尚未被转移至其创建线程对应的 Stack 中。因此，这个条件需要控制的事项是：如果对象已经被回收线程回收，则停止本次的回收操作。有关 `recycleId` 和 `lastRecycledId` 之间关系的变化及其含义，建议同学们回顾《9.3 从 Stack 中获取池化对象》小节，那里有详细介绍。
- `**stack == null**`：这种情况在前面已经提到过，当池化对象对应的创建线程挂掉时，对应的 Stack 随后也会被 GC 回收。在这种情况下，就不需要再回收该池化对象了。

通过这些判断，可以有效地管理对象的回收状态，避免不必要的回收操作，从而提高系统的稳定性和性能。

### 回收对象至Stack中——啊哈！Bug!

```java
private static final class Stack<T> {
    //持有对应创建线程的弱引用
    final WeakReference<Thread> threadRef;

    void push(DefaultHandle<?> item) {
        Thread currentThread = Thread.currentThread();
        //判断当前线程是否为创建线程  对象池的回收原则是谁创建，最终由谁回收。其他线程只是将回收对象放入weakOrderQueue中
        //最终是要回收到创建线程对应的stack中的
        if (threadRef.get() == currentThread) {
            // 如果当前线程正是创建对象的线程，则直接进行回收 直接放入与创建线程关联的stack中
            pushNow(item);
        } else {
            // 当前线程不是创建线程，则将回收对象放入创建线程对应的stack中的weakOrderQueue链表相应节点中（currentThread对应的节点）
            pushLater(item, currentThread);
        }
    }
}
```

在这里，池化对象的 `DefaultHandler` 会持有的 Stack 中进行对象的回收。

在分析以下的 `if...else...` 逻辑判断时，大家可以思考是否存在什么问题？Bug 就在这里！

首先，会判断当前回收线程是否为池化对象的创建线程：`threadRef.get() == currentThread`。如果是，则由创建线程直接进行回收 `pushNow(item)`。

如果 `threadRef.get() != currentThread`，则有两种情况：

1. `**currentThread**` **是回收线程**：此时按多线程回收的逻辑 `pushLater(item, currentThread)`，由回收线程将对象回收至其对应的 `WeakOrderQueue` 节点中，这里没有问题。
2. **第二种情况**：当 `threadRef.get() == null` 时，表示该回收对象的创建线程已经挂掉，并被 GC 回收。在这种情况下，已经没有必要再对该对象进行回收，因为创建线程已挂掉，随后对应的 Stack 也会被 GC 掉。即使该对象被回收进 Stack，也永远不会被使用。

然而，Netty 的做法仍然会让回收线程将其回收至 Stack 中的 `WeakOrderQueue` 链表中。笔者认为这里根本就没有必要将其添加至 `WeakOrderQueue` 链表中。

Bug 产生的场景如下图所示：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729954100661-fb41cf3a-4194-4784-becd-53e55788cbbc.webp)

**在第二种情况下，Netty还有一个重要的场景没有考虑到，会导致内存泄露！！**

什么场景呢？大家再来回顾下池化对象与对象池之间的引用关系图：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729954133229-a947288c-d63a-4bdb-873b-57f13d7a1fa7.webp)

这里我们看到池化对象会引用DefaultHandler，而DefaultHandler又强引用了Stack。于是就形成了这样一条引用链：

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729954146210-09daeca2-10b3-466e-b7ae-c938d7119808.webp)

而池化对象是对外暴露的，用户可能在某个地方一直引用着这个池化对象，如果创建线程挂掉，并被GC回收之后，那么其在对象池中对应的Stack也应该被回收，因为Stack里保存的回收对象将再也不会被用到了。但是因为这条引用链的存在，导致Stack无法被GC回收从而造成内存泄露！

### 笔者反手一个PR，修复这个Bug!

此处笔者为 微信公众号【bin的技术小屋】！！

现在Bug产生的原因和造成的影响，笔者为大家已经分析清楚了，那么接下来的解决方案就变得很简单了。

笔者先向Netty社区提了一个 Issue11864 来说明这个问题。

Issue11864 : https://github.com/netty/netty/issues/11864

然后直接提了 PR11865 来修复这个Bug。

PR : https://github.com/netty/netty/pull/11865

PR中主要的修改点分为以下两点：

1. 笔者在修复方案中觉得在这里应该尽早处理掉 `threadRef.get() == null` 的情况，因为创建线程已经死掉，此时在为创建线程回收对象已经没有任何意义了，这种情况直接 return 掉就好。
2. 由于池化对象强引用到了其创建线程对应的Stack，当创建线程挂掉之后，我们需要解除这个引用链 `item.stack = null`，保证Stack最终可以被GC回收。

以下代码为笔者提交的PR中的修复方案，主要增加了对 `threadRef.get() == null` 情况的处理，并添加了详细注释。

```java
void push(DefaultHandle<?> item) {
    Thread currentThread = Thread.currentThread();
    if (threadRef.get() == currentThread) {
        pushNow(item);
    } else if (threadRef.get() == null) {
        // when the thread that belonged to the Stack was died or GC'ed，
        // There is no need to add this item to WeakOrderQueue-linked-list which belonged to the Stack any more
        item.stack = null;
    } else {
        pushLater(item, currentThread);
    }
}
```

但是后面还是有其他的问题：
Issue11864 : https://github.com/netty/netty/issues/11864

于是作者 chrisvest 又提了一个 PR11996 最终在 **4.1.74.Final**版本中修复了笔者提的这个 Issue11864。

PR11996 ：https://github.com/netty/netty/pull/11996

这里笔者将这个Bug在 **4.1.74.Final** 版本中的最终修复方案和大家说明一下，收个尾。

1. 首先 chrisvest 大牛 认为 当创建线程挂掉的时候，我们可以在threadLocal的 onRemoval方法中将创建线程对应的LocalPool里边用于存放回收对象的pooledHandles 直接置为 null。这里的语义是标记LocalPool已经死掉了，不会再继续使用。

```java
public abstract class Recycler<T> {

    private final FastThreadLocal<LocalPool<T>> threadLocal = new FastThreadLocal<LocalPool<T>>() {
        @Override
        protected LocalPool<T> initialValue() {
            return new LocalPool<T>(maxCapacityPerThread, interval, chunkSize);
        }

        @Override
        protected void onRemoval(LocalPool<T> value) throws Exception {
            //删除LocalPool
            super.onRemoval(value);
            MessagePassingQueue<DefaultHandle<T>> handles = value.pooledHandles;
            //pooledHandles 置为 null，取消引用
            value.pooledHandles = null;
            //清除LocalPool中保存的回收对象
            handles.clear();
        }
    };

}
```

1. 在多线程回收对象的时候，会首先判断该回收对象对应的LocalPool里的pooledHandles是否已经被清理变为不可用状态。如果是的话就停止回收。

```java
private static final class LocalPool<T> {
    //保证可见性
    private volatile MessagePassingQueue<DefaultHandle<T>> pooledHandles;

     void release(DefaultHandle<T> handle) {
            MessagePassingQueue<DefaultHandle<T>> handles = pooledHandles;
            handle.toAvailable();
            if (handles != null) {
                handles.relaxedOffer(handle);
            }
        }
}
```

通过以上两个措施 就保证了 当创建线程被GC掉之后，它对应的 在对象池中的回收缓存LocalPool（类比Stack）不会出现内存泄露，同时保证了多线程不在将回收对象至已经被清理的LocalPool中。

在重构后的版本中引入了 LocalPool 来代替我们前边介绍的Stack。LocalPool中的pooledHandles大家可以简单认为类似Stack中数组栈的功能

好了，这一块的Bug修改我们介绍完了，我们继续多线程回收对象主流程的介绍：

### 创建线程直接回收对象

```java
private void pushNow(DefaultHandle<?> item) {
    //池化对象被回收前 recycleId = lastRecycleId = 0
    //如果其中之一不为0 说明已经被回收了
    if ((item.recycleId | item.lastRecycledId) != 0) {
        throw new IllegalStateException("recycled already");
    }

    //此处是由创建线程回收，则将池化对象的recycleId与lastRecycleId设置为创建线程Id-OWN_THREAD_ID
    //注意这里的OWN_THREAD_ID是一个固定的值，是因为这里的视角是池化对象的视角，只需要区分创建线程和非创建线程即可。
    //对于一个池化对象来说创建线程只有一个 所以用一个固定的OWN_THREAD_ID来表示创建线程Id
    item.recycleId = item.lastRecycledId = OWN_THREAD_ID;

    int size = this.size;
    //如果当前池化对象的容量已经超过最大容量 则丢弃对象
    //为了避免池化对象的急速膨胀，这里只会回收1/8的对象，剩下的对象都需要丢弃
    if (size >= maxCapacity || dropHandle(item)) {
        // Hit the maximum capacity or should drop - drop the possibly youngest object.
        //丢弃对象
        return;
    }

    //当前线程对应的stack容量已满但是还没超过最大容量限制，则对stack进行扩容
    if (size == elements.length) {
        //容量扩大两倍
        elements = Arrays.copyOf(elements, min(size << 1, maxCapacity));
    }
    //将对象回收至当前stack中
    elements[size] = item;
    //更新当前stack的栈顶指针
    this.size = size + 1;
}
```

首先，需要判断该回收对象是否已经被回收。条件为 `(item.recycleId | item.lastRecycledId) != 0`，只要任意一个 ID 不为 0，说明该对象已经被回收，则停止本次回收操作。

当对象被创建线程回收时，设置回收 ID：`item.recycleId = item.lastRecycledId = OWN_THREAD_ID;`

接下来，如果当前 Stack 已达到最大容量，则直接丢弃该对象。

为了避免对象池不可控制地迅速膨胀，这里只会回收 **1/8** 的对象，其余对象将被丢弃，使用 `dropHandle` 方法处理。

如果当前 Stack 的容量已满但还未超过最大容量限制，则对 Stack 进行扩容。扩容的策略是一次性扩容两倍，但不能超过最大容量限制。

最后，将对象压入 Stack 结构中的数组栈中，完成对象的回收。通过这些步骤，可以有效地管理对象的回收，控制对象池的大小，从而保持系统的性能和稳定性。

### 回收线程间接回收对象

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729954596384-d9637209-f99b-46e0-be80-6049d3e51c86.webp)

在 Recycler 对象池中，一个线程既可以是创建线程，也可以是回收线程。

例如，在线程图中，`thread2`、`thread3`、`thread4` 等线程可以在对象池中创建对象，并将对象回收至自己对应的 Stack 结构中的数组栈中，此时它们的角色是创建线程。而 `thread1` 则是一个示例，表示它正在执行创建操作。

同时，其他线程（例如 `thread2`、`thread3`、`thread4`）也可以为 `thread1` 回收由 `thread1` 创建的对象，将这些对象回收至 `thread1` 对应的 Stack 结构中的 `WeakOrderQueue` 链表中。在这种情况下，`thread2`、`thread3`、`thread4` 的角色变为回收线程。

在之前介绍 Recycler 对象池的重要属性时，我们提到过 `maxDelayedQueuesPerThread` 属性。这个属性的作用是限制每个线程可拥有的延迟队列的最大数量，从而控制资源的使用和回收效率。通过合理配置这个属性，可以避免过多的延迟队列导致的内存浪费，同时提高对象回收的效率。

```java
public abstract class Recycler<T> {

    //每个回收线程最多可以帮助多少个创建线程回收对象 默认：cpu核数 * 2
    private static final int MAX_DELAYED_QUEUES_PER_THREAD;

    //一个回收线程可帮助多少个创建线程回收对象
    private final int maxDelayedQueuesPerThread;

    private static final class Stack<T> {

        // 当前线程可以帮助多少个线程回收其池化对象
        private final int maxDelayedQueues;

    }

}
```

在Recycler对象池中，一个回收线程能够帮助多少个创建线程回收对象是有限制的，通过 maxDelayedQueuesPerThread属性 控制。

**那么在对象池中，一个回收线程如何存储为其他创建线程回收到的对象呢**？

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729954703489-2dbd128c-caae-445b-b447-481b765f9392.webp)

如图所示，从回收线程的视角来看，在对象池中有一个 `FastThreadLocal` 类型的 `DELAYED_RECYCLED` 字段。`DELAYED_RECYCLED` 为每个回收线程保存了一个 `WeakHashMap`，正是这个回收线程持有的 `WeakHashMap` 结构中保存了该回收线程为每个创建线程回收的对象。

- **WeakHashMap 结构**：

- - **Key**：表示创建线程对应的 Stack 结构。这意味着该回收线程为哪个创建线程回收对象。
  - **Value**：表示该回收线程在创建线程中对应 Stack 结构里的 `WeakOrderQueue` 链表中对应的节点。

结合《Recycler对象池.png》这幅图，大家可以仔细体会这个结构设计。通过这种设计，回收线程可以有效地管理和追踪为不同创建线程回收的对象，从而提高对象回收的效率和准确性。同时，由于使用了 `WeakHashMap`，当创建线程的 Stack 不再被引用时，这些回收的对象也可以被垃圾回收器回收，避免内存泄漏。

```java
public abstract class Recycler<T> {

    //实现跨线程回收的核心，这里保存的是当前线程为其他线程回收的对象（由其他线程创建的池化对象）
    //key: 池化对象对应的创建线程stack  value: 当前线程代替该创建线程回收的池化对象 存放在weakOrderQueue中
    //这里的value即是 创建线程对应stack中的weakOrderQueue链表中的节点（每个节点表示其他线程为当前创建线程回收的对象）
    private static final FastThreadLocal<Map<Stack<?>, WeakOrderQueue>> DELAYED_RECYCLED =
            new FastThreadLocal<Map<Stack<?>, WeakOrderQueue>>() {
        @Override
        protected Map<Stack<?>, WeakOrderQueue> initialValue() {
            return new WeakHashMap<Stack<?>, WeakOrderQueue>();
        }
    };

}
```

而这个 `WeakHashMap` 的 `size` 表示当前回收线程正在为多少个创建线程回收对象，且其值不能超过 `maxDelayedQueuesPerThread`。

**为什么要使用** `**WeakHashMap**`**？**

实际上，我们之前已经提到过，考虑一种极端情况：当创建线程挂掉并被 GC 回收后，相关的 Stack 结构实际上已无用。此时，存储在 Stack 结构中的池化对象将永远不会再被使用。因此，回收线程就没有必要为已挂掉的创建线程回收对象。如果该 Stack 结构没有任何引用链存在，它随后也会被 GC 回收。在 `WeakHashMap` 中，这个 Stack 结构对应的 Entry 也会被自动删除。如果不采用 `WeakHashMap`，那么回收线程为该 Stack 回收的对象将一直停留在回收线程中。

介绍完这些背景知识后，下面我们正式介绍回收线程如何帮助创建线程回收对象：

```java
private void pushLater(DefaultHandle<?> item, Thread thread) {
    //maxDelayQueues == 0 表示不支持对象的跨线程回收
    if (maxDelayedQueues == 0) {
        //直接丢弃
        return;
    }
    
    //注意这里的视角切换，当前线程为回收线程
    Map<Stack<?>, WeakOrderQueue> delayedRecycled = DELAYED_RECYCLED.get();
    //获取当前回收对象属于的stack 由当前线程帮助其回收  注意这里是跨线程回收 当前线程并不是创建线程
    WeakOrderQueue queue = delayedRecycled.get(this);
    //queue == null 表示当前线程是第一次为该stack回收对象
    if (queue == null) {
        //maxDelayedQueues指示一个线程最多可以帮助多少个线程回收其创建的对象
        //delayedRecycled.size()表示当前线程已经帮助多少个线程回收对象
        if (delayedRecycled.size() >= maxDelayedQueues) {
        
            //如果超过指定帮助线程个数，则停止为其创建WeakOrderQueue，停止为其回收对象
            //WeakOrderQueue.DUMMY这里是一个标识，后边遇到这个标识  就不会为其回收对象了
            delayedRecycled.put(this, WeakOrderQueue.DUMMY);
            return;
        }

        // 创建为回收线程对应的WeakOrderQueue节点以便保存当前线程为其回收的对象
        if ((queue = newWeakOrderQueue(thread)) == null) {
            // 创建失败则丢弃对象
            return;
        }
        //在当前线程的threadLocal中建立 回收对象对应的stack 与 weakOrderQueue的对应关系
        delayedRecycled.put(this, queue);
    } else if (queue == WeakOrderQueue.DUMMY) {
        // drop object
        // 如果queue的值是WeakOrderQueue.DUMMY 表示当前已经超过了允许帮助的线程数 直接丢弃对象
        return;
    }

    //当前线程为对象的创建线程回收对象  放入对应的weakOrderQueue中
    queue.add(item);
}
```

1. 首先需要判断当前 `Recycler` 对象池是否支持跨线程回收。`maxDelayedQueues == 0` 表示不支持对象的跨线程回收。
2. 如果当前回收线程是第一次为该回收对象的创建线程进行回收，则需要在对象的创建线程对应的 Stack 结构中创建相应的 `WeakOrderQueue` 节点（这正是多线程无锁化回收对象的核心所在）。在创建之前，需要判断是否超过可帮助创建线程的个数 `maxDelayedQueues`。
3. 如果当前回收线程帮助的创建线程个数已经超过 `maxDelayedQueues` 限制，则向对应的 `WeakHashMap` 中插入一个空的 `WeakOrderQueue` 节点 `DUMMY`。后续如果遇到 `WeakOrderQueue` 节点是 `DUMMY` 实例，则丢弃对象，放弃回收。

```java
private static final class WeakOrderQueue extends WeakReference<Thread> {
    //作为一个标识，遇到DUMMY实例，则直接丢弃回收对象
    static final WeakOrderQueue DUMMY = new WeakOrderQueue();
}
```

1. 如果当前回收线程帮助的创建线程个数还没有超过 `maxDelayedQueues` 限制，则通过 `stack#newWeakOrderQueue` 为当前回收线程在回收对象对应的 Stack 结构中创建相应的 `WeakOrderQueue` 节点，并在回收线程持有的 `WeakHashMap` 中建立 Stack 与回收线程对应的 `WeakOrderQueue` 节点的关联关系。
2. 最终，由回收线程将对象回收至其创建线程对应的 Stack 结构中（将回收对象添加至回收线程对应的 `WeakOrderQueue` 节点中，完成多线程无锁化回收）

### 为回收线程创建对应的WeakOrderQueue节点

上小节提到，当回收线程第一次为创建线程回收对象的时候，需要在创建线程对应Stack结构中的WeakOrderQueue链表中创建与回收线程对应的WeakOrderQueue节点。

```java
private static final class Stack<T> {
     private WeakOrderQueue newWeakOrderQueue(Thread thread) {
          return WeakOrderQueue.newQueue(this, thread);
    }
}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729955853821-64b4da6d-d961-4f3d-bfea-defe24316654.webp)

```java
private static final class WeakOrderQueue extends WeakReference<Thread> {

    static WeakOrderQueue newQueue(Stack<?> stack, Thread thread) {

        // link是weakOrderQueue中存储回收对象的最小结构，此处是为接下来要创建的Link预订空间容量
        // 如果stack指定的availableSharedCapacity 小于 LINK_CAPACITY大小，则分配失败
        if (!Head.reserveSpaceForLink(stack.availableSharedCapacity)) {
            return null;
        }

        //如果还够容量来分配一个link那么就创建weakOrderQueue
        final WeakOrderQueue queue = new WeakOrderQueue(stack, thread);

        // 向stack中的weakOrderQueue链表中添加当前回收线程对应的weakOrderQueue节点（始终在头结点处添加节点 ）
        // 此处向stack中添加weakOrderQueue节点的操作被移到WeakOrderQueue构造器之外的目的是防止WeakOrderQueue.this指针
        // 逃逸避免被其他线程在其构造的过程中访问
        stack.setHead(queue);

        return queue;
    }

}
```

在前面介绍 `WeakOrderQueue` 的结构时，我们提到 `WeakOrderQueue` 其实是由 Link 节点组成的链表。在初始状态下，`WeakOrderQueue` 只包含一个 Link 节点的链表。

创建 `WeakOrderQueue` 结构时，需要同时为其创建一个 Link 节点。这些 Link 节点是实际保存回收线程所回收到的对象的地方。

对于一个创建线程而言，所有回收线程能够为其回收的对象总量是受 `availableSharedCapacity` 限制的。每创建一个 Link 节点，其值就减少一个 `LINK_CAPACITY`；每释放一个 Link 节点，其值就增加一个 `LINK_CAPACITY`。这样可以确保所有回收线程的回收总量不会超过 `availableSharedCapacity` 的限制。

因此，在为 `WeakOrderQueue` 结构创建首个 Link 节点时，需要判断当前所有回收线程回收的对象总量是否已经超过了 `availableSharedCapacity`。如果容量足够回收一个 Link 大小的对象，则开始创建 `WeakOrderQueue` 结构。

如果当前回收容量已经超过 `availableSharedCapacity` 或不足以回收一个 Link 大小的对象，则停止创建 `WeakOrderQueue` 节点，回收流程终止，不再对该回收对象进行回收。

```java
//此处目的是为接下来要创建的link预留空间容量
static boolean reserveSpaceForLink(AtomicInteger availableSharedCapacity) {
    for (;;) {
        //获取stack中允许异线程回收对象的总容量（异线程还能为该stack收集多少对象）
        int available = availableSharedCapacity.get();
        //当availbale可供回收容量小于一个Link时，说明异线程回收对象已经达到上限，不能在为stack回收对象了
        if (available < LINK_CAPACITY) {
            return false;
        }
        //为Link预留到一个Link的空间容量，更新availableSharedCapacity
        if (availableSharedCapacity.compareAndSet(available, available - LINK_CAPACITY)) {
            return true;
        }
    }
}
```

这里的预订容量实际上是将 `availableSharedCapacity` 的值减去一个 `LINK_CAPACITY` 大小。其他回收线程会观察到这个 `availableSharedCapacity` 容量的变化，从而方便决定是否继续为创建线程回收对象。

当为 `WeakOrderQueue` 结构的首个 Link 节点预订容量成功后，就开始创建 `WeakOrderQueue` 节点。

```java
//为了使stack进行GC,这里不会持有其所属stack的引用
private WeakOrderQueue(Stack<?> stack, Thread thread) {
    //weakOrderQueue持有对应跨线程的弱引用
    super(thread);
    //创建尾结点
    tail = new Link();

    // 创建头结点  availableSharedCapacity = maxCapacity / maxSharedCapacityFactor
    // 此时availableSharedCapacity的值已经变化了，减去了一个link的大小
    head = new Head(stack.availableSharedCapacity);
    head.link = tail;
    interval = stack.delayedQueueInterval;
    handleRecycleCount = interval; 
}
```

 当回收线程对应的 `WeakOrderQueue` 节点创建成功后，就将其插入到回收对象对应的 Stack 结构中的 `WeakOrderQueue` 链表的头结点处。由于可能涉及多个回收线程并发向 `WeakOrderQueue` 链表头结点添加节点，因此更新 Stack 结构中 `WeakOrderQueue` 链表头结点的方法被设计为同步方法。这也是整个 `Recycler` 对象池设计中唯一的一个同步方法。  

```java
synchronized void setHead(WeakOrderQueue queue) {
    //始终在weakOrderQueue链表头结点插入新的queue（其他线程收集的由本线程创建的对象）
    queue.setNext(head);
    head = queue;
}
```

![img](https://cdn.nlark.com/yuque/0/2024/webp/35210587/1729956117412-2a778aa7-dd35-47dc-8715-3795d0411b3f.webp)

### 向WeakOrderQueue节点中添加回收对象

终于到了多线程回收对象的最后一步，本文也接近尾声，大家坚持一下！

在这一阶段，需要将回收对象添加到回收线程对应的 `WeakOrderQueue` 节点中。Netty 会在 Link 链表的尾结点处添加回收对象。如果尾结点的容量已满，就会继续新创建一个 Link，将回收对象添加到新的 Link 节点中。

```java
void add(DefaultHandle<?> handle) {
    //将handler中的lastRecycledId标记为当前weakOrderQueue中的Id,一个stack和一个回收线程对应一个weakOrderQueue节点
    //表示该池化对象 最近的一次是被当前回收线程回收的。
    handle.lastRecycledId = id;

    // 控制异线程回收频率 只回收1/8的对象
    // 这里需要关注的细节是其实在scavengeSome方法中将weakOrderQueue中的待回收对象转移到创建线程的stack中时，Netty也会做回收频率的限制
    // 这里在回收线程回收的时候也会控制回收频率（总体控制两次）netty认为越早的做回收频率控制越好 这样可以避免weakOrderQueue中的容量迅速的增长从而失去控制
    if (handleRecycleCount < interval) {
        handleRecycleCount++;
        // Drop the item to prevent recycling to aggressive.
        return;
    }
    handleRecycleCount = 0;

    //从尾部link节点开始添加新的回收对象
    Link tail = this.tail;
    int writeIndex;

    //如果当前尾部link节点容量已满，就需要创建新的link节点
    if ((writeIndex = tail.get()) == LINK_CAPACITY) {
        //创建新的Link节点
        Link link = head.newLink();
        //如果availableSharedCapacity的容量不够了，则无法创建Link。丢弃待回收对象
        if (link == null) {
            // 丢弃对象
            return;
        }
        // We allocate a Link so reserve the space
        //更新尾结点
        this.tail = tail = tail.next = link;

        writeIndex = tail.get();
    }

    //将回收对象handler放入尾部link节点中
    tail.elements[writeIndex] = handle;
    //这里将stack置为null，是为了方便stack被回收。
    //如果Stack不再使用，期望被GC回收，发现handle中还持有stack的引用，那么就无法被GC回收，从而造成内存泄漏
    //在从对象池中再次取出该对象时，stack还会被重新赋予
    handle.stack = null;
    //注意这里用lazySet来延迟更新writeIndex。只有当writeIndex更新之后，在创建线程中才可以看到该待回收对象
    //保证线程最终可见而不保证立即可见的原因就是 其实这里Netty还是为了性能考虑避免执行内存屏障指令的开销。
    //况且这里也并不需要考虑线程的可见性，当创建线程调用scavengeSome从weakOrderQueue链表中回收对象时，看不到当前节点weakOrderQueue
    //新添加的对象也没关系，因为是多线程一起回收，所以继续找下一个节点就好。及时全没看到，大不了就在创建一个对象。主要还是为了提高weakOrderQueue的写入性能
    tail.lazySet(writeIndex + 1);
}
```

1. 首先，第一步是设置回收对象 `DefaultHandler` 中的 `lastRecycledId`，将其设置为当前回收线程的 ID，表示该回收对象最近一次是由当前回收线程回收的。此时，`DefaultHandler` 中的 `recycleId` 不等于 `lastRecycledId`，对象处于半回收状态。
2. 控制回收线程的回收频率（只回收 1/8 的对象）。大家是否还记得我们在《9.5 转移回收对象》小节中介绍的 `stack#scavengeSome` 方法？在创建线程从 Stack 中的 `WeakOrderQueue` 链表中转移对象到数组栈时，也会受到回收频率的控制，只转移 1/8 的对象。因此，可以看到在多线程回收对象的过程中，回收频率的控制会执行两次。Netty 认为越早进行回收频率控制越好，这样可以避免 `WeakOrderQueue` 中的容量迅速增长，从而失去控制。
3. 在 `WeakOrderQueue` 结构中，当我们向 Link 链表添加回收对象时，都会向 Link 链表的尾结点添加回收对象。如果当前尾结点容量已经满了（即 `writeIndex = tail.get() == LINK_CAPACITY`），我们就需要新创建一个 Link 节点，并将 `tail` 指针指向新的 Link 节点以更新尾结点。最后，将回收对象回收至新的尾结点中。当然，我们也要考虑到 `availableSharedCapacity` 容量的限制。如果容量不足，就不能新建 Link 节点，直接将回收对象丢弃，停止回收。

```java
private static final class Head {

     Link newLink() {
          //此处的availableSharedCapacity可能已经被多个回收线程改变，因为availableSharedCapacity是用来控制回收线程回收的总容量限制
          //每个回收线程再回收对象时都需要更新availableSharedCapacity
          return reserveSpaceForLink(availableSharedCapacity) ? new Link() : null;
     }

    //此处目的是为接下来要创建的link预留空间容量
    static boolean reserveSpaceForLink(AtomicInteger availableSharedCapacity) {
        for (;;) {
            //获取stack中允许异线程回收对象的总容量（异线程还能为该stack收集多少对象）
            int available = availableSharedCapacity.get();
            //当availbale可供回收容量小于一个Link时，说明异线程回收对象已经达到上限，不能在为stack回收对象了
            if (available < LINK_CAPACITY) {
                return false;
            }
            //为Link预留到一个Link的空间容量，更新availableSharedCapacity
            if (availableSharedCapacity.compareAndSet(available, available - LINK_CAPACITY)) {
                return true;
            }
        }
    }
}
```

到这里Recycler对象池的整个**多线程无锁化回收对象**的流程笔者就为大家介绍完了。

但是这里还有两个点，笔者想要和大家再强调一下：

**第一：为什么这里会将handle.stack设置为null**?

不知大家还记不记得我们在介绍 `stack#scavengeSome方法` 的时候专门提到，在创建线程遍历WeakOrderQueue链表将链表中的待回收对象转移至stack中的数组栈时，会将待回收对象的DefaultHandler持有的stack重新设置为其创建线程对应的stack。

```java
boolean transfer(Stack<?> dst) {

.................省略..............

//重新为defaultHandler设置其所属stack(初始创建该handler的线程对应的stack)
//该defaultHandler在被回收对象回收的时候，会将其stack置为null，防止极端情况下，创建线程挂掉，对应stack无法被GC
element.stack = dst;

.................省略..............
}
```

而这里在回收线程向WeakOrderQueue节点添加回收对象时先将 handle.stack设置为 null，而在转移回收对象时又将 handle.stack 设置回来，这不是多此一举吗？

其实并不是多此一举，这样设计是非常有必要的，我们假设一种极端的情况，当创建线程挂掉并被GC回收之后，其实stack中存储的回收对象已经不可能在被使用到了，stack应该也被回收掉。但是如果这里回收线程在回收的时候不将对象持有的stack设置为null的话，直接添加到了WeakOrderQueue节点中，当创建被GC掉的时候，由于这条引用链的存在导致对应stack永远不会被GC掉，造成内存泄露。

所以笔者在本文中多次强调，当我们在设计比较复杂的程序结构时，对于对象之间的引用关系，一定要时刻保持清晰的认识，防止内存泄露。

**第二：为什么最后使用lazySet来更新尾结点的writeIndex**？

当我们向Link链表的尾结点添加完回收对象之后，在更新尾结点的writeIndex时，使用到了延时更新，而延时更新并不会保证多线程的可见性，如果此时创建线程正在转移对象，那么将不会看到新添加进来的回收对象了。

而事实上，我们这里并不需要保证线程之间的实时可见性，只需要保证最终可见性即可。

确实在当创建线程转移对象的时候可能并不会看到刚刚被回收线程新添加进来的回收对象，看不到没关系，创建线程大不了在本次转移中不回收它不就完了么。因为只要创建线程Stack结构中的数组栈为空，创建线程就会从WeakOrderQueue链表中转移对象，以后会有很多次机会来WeakOrderQueu链表中转移对象，什么时候看见了，什么时候转移它。并不需要实时性。退一万步讲，即使全部看不到，大不了创建线程直接创建一个对象返回就行了。

而如果这里要保证线程之间的实时可见性，在更新尾结点的writeIndex的时候就不得不插入 LOCK 前缀内存屏障指令保证多线程之间的实时可见性，而执行内存屏障指令是需要开销的，所以**为了保证WeakOrderQueue的写入性能**，Netty这里选择了只保证最终可见性而不保证实时可见性。

## 总结

到这里关于Recycler对象池的整个设计与源码实现，笔者就为大家详细的剖析完毕了，在剖析的过程中，我们提炼出了很多多线程并发程序的设计要点和注意事项。大家可以在日常开发工作中多多体会并实践。

虽然本文介绍的Recycler对象池整体设计在**4.1.71.Final**版本中已经被重构，笔者提的Issue最终在**4.1.74.Final**版本被修复，但是在当前版本Recycler对象池的设计和实现中，我们还是可以学习到很多东西的。

笔者真心十分佩服能够耐心看到这里的大家，不知不觉已经唠叨了三万多字了，谢谢大家的观看~~，大家记得晚餐时给自己加餐个鸡腿奖励一下自己，哈哈！！