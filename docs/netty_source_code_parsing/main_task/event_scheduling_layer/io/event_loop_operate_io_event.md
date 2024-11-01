# Reactor 监听 IO 事件

## 前言

在[《核心引擎 Reactor 的运转架构》](/netty_source_code_parsing/main_task/event_scheduling_layer/reactor_dispatch)中，我们得知 Reactor 线程在轮询过程中会去不断轮询捕获 IO 事件并处理，对标如下代码

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301622577.png)

也就是下图红框处

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410311634691.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241031163402539" style="zoom:33%;" />

本文旨在说明 Reactor 是如何去捕获到 IO 就绪事件的，以及 IO 事件的注册时机

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301622553.png)

从方法签名可以推测出一个是经过优化的处理方法，一个是普通的处理方法。

我们先来看看这个优化是啥东西

## Netty 对 Java NIO Selector 的优化

首先，在 `NioEventLoop` 中有一个 `Selector` 优化开关 `DISABLE_KEY_SET_OPTIMIZATION`，可以通过系统变量 `-Dio.netty.noKeySetOptimization` 指定，默认是开启的。这表示 Netty 会对 JDK NIO 原生 `Selector` 进行优化。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301622626.png)

如果优化开关 `DISABLE_KEY_SET_OPTIMIZATION` 被关闭，那么 Netty 将直接返回 JDK NIO 原生的 `Selector`，不进行任何优化。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301622618.png)

**下面为 Netty 对 JDK NIO 原生的 Selector 的优化过程：**

1. 获取`JDK NIO原生Selector`的抽象实现类`sun.nio.ch.SelectorImpl`。`JDK NIO原生Selector`的实现均继承于该抽象类。用于判断由`SelectorProvider`创建出来的`Selector`是否为`JDK默认实现`（`SelectorProvider`第三种加载方式）。因为`SelectorProvider`可以是自定义加载，所以它创建出来的`Selector`并不一定是 JDK NIO 原生的。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301622684.png)

JDK NIO Selector 的抽象类`sun.nio.ch.SelectorImpl`

```java
public abstract class SelectorImpl extends AbstractSelector {

    // The set of keys with data ready for an operation
    // //IO就绪的SelectionKey（里面包裹着channel）
    protected Set<SelectionKey> selectedKeys;

    // The set of keys registered with this Selector
    //注册在该Selector上的所有SelectionKey（里面包裹着channel）
    protected HashSet<SelectionKey> keys;

    // Public views of the key sets
    //用于向调用线程返回的keys，不可变
    private Set<SelectionKey> publicKeys;             // Immutable
    //当有IO就绪的SelectionKey时，向调用线程返回。只可删除其中元素，不可增加
    private Set<SelectionKey> publicSelectedKeys;     // Removal allowed, but not addition

    protected SelectorImpl(SelectorProvider sp) {
        super(sp);
        keys = new HashSet<SelectionKey>();
        selectedKeys = new HashSet<SelectionKey>();
        if (Util.atBugLevel("1.4")) {
            publicKeys = keys;
            publicSelectedKeys = selectedKeys;
        } else {
            //不可变
            publicKeys = Collections.unmodifiableSet(keys);
            //只可删除其中元素，不可增加
            publicSelectedKeys = Util.ungrowableSet(selectedKeys);
        }
    }
}
```

这里笔者来简单介绍下 JDK NIO 中的`Selector`中这几个字段的含义，我们可以和[《IO 多路复用》](/netty_source_code_parsing/network_program/io_multiplexing)讲到的 epoll 在内核中的结构做类比，方便大家后续的理解：

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/image-20241029235334293.png)

在 `Selector` 中的几个关键集合和字段与 `Epoll` 机制类似：

- `Set<SelectionKey> selectedKeys`：

  - `selectedKeys` 可以类比为 `Epoll` 中的就绪队列 `eventpoll->rdllist`，存放所有当前 I/O 就绪的 `Channel`，也就是已经满足操作条件的通道。
  - 每当 `Selector` 监听到某个 `Channel` 就绪，就将对应的 `SelectionKey` 添加到 `selectedKeys` 中。
  - `SelectionKey` 可以理解为 `Channel` 在 `Selector` 中的一个标记，与 `epoll_event` 类似，封装了 I/O 就绪的 `Socket` 信息。

- `HashSet<SelectionKey> keys`：

  - `keys` 存放所有注册到该 `Selector` 的 `Channel`，与 `epoll` 中管理所有文件描述符的红黑树结构 `rb_root` 类似。
  - 当 `Channel` 注册到 `Selector` 后，会生成对应的 `SelectionKey`，并将该 `SelectionKey` 添加到 `keys` 中。

- `Set<SelectionKey> publicSelectedKeys`：

  - `publicSelectedKeys` 是 `selectedKeys` 的外部视图，外部线程可以通过该集合获取所有 I/O 就绪的 `SelectionKey`。
  - 这个集合为只读视图，外部线程只能删除元素，不能增加，并且集合不是线程安全的，以避免多线程并发写入导致的问题。

- `Set<SelectionKey> publicKeys`：
  - `publicKeys` 是 `keys` 的不可变视图，外部线程可以通过它获取所有注册到该 `Selector` 上的 `SelectionKey`。

**这里需要重点关注抽象类**`sun.nio.ch.SelectorImpl`**中的**`selectedKeys`**和**`publicSelectedKeys`**这两个字段，注意它们的类型都是**`HashSet`**，一会优化的就是这里！！！！**

2. 判断由`SelectorProvider`创建出来的`Selector`是否是 JDK NIO 原生的`Selector`实现。**因为 Netty 优化针对的是 JDK NIO 原生**`Selector`。判断标准为`sun.nio.ch.SelectorImpl`类是否为`SelectorProvider`创建出`Selector`的父类。如果不是则直接返回。不在继续下面的优化过程。

```java
//判断是否可以对Selector进行优化，这里主要针对JDK NIO原生Selector的实现类进行优化，因为SelectorProvider可以加载的是自定义Selector实现
//如果SelectorProvider创建的Selector不是JDK原生sun.nio.ch.SelectorImpl的实现类，那么无法进行优化，直接返回
if (!(maybeSelectorImplClass instanceof Class) ||
    !((Class<?>) maybeSelectorImplClass).isAssignableFrom(unwrappedSelector.getClass())) {
    if (maybeSelectorImplClass instanceof Throwable) {
        Throwable t = (Throwable) maybeSelectorImplClass;
        logger.trace("failed to instrument a special java.util.Set into: {}", unwrappedSelector, t);
    }
    return new SelectorTuple(unwrappedSelector);
}
```

通过前面对`SelectorProvider`的介绍我们知道，这里通过`provider.openSelector()`创建出来的`Selector`实现类为`KQueueSelectorImpl类`，它继承实现了`sun.nio.ch.SelectorImpl`，所以它是 JDK NIO 原生的`Selector`实现

```java
class KQueueSelectorImpl extends SelectorImpl {}
```

3. 创建`SelectedSelectionKeySet`通过反射替换掉`sun.nio.ch.SelectorImpl类`中`selectedKeys`和`publicSelectedKeys`的默认`HashSet`实现。

**为什么要用**`SelectedSelectionKeySet`**替换掉原来的**`HashSet`**呢？？**

因为这里涉及到对`HashSet类型`的`sun.nio.ch.SelectorImpl#selectedKeys`集合的两种操作：

- **插入操作：** 通过前边对`sun.nio.ch.SelectorImpl类`中字段的介绍我们知道，在`Selector`监听到`IO就绪`的`SelectionKey`后，会将`IO就绪`的`SelectionKey`**插入**`sun.nio.ch.SelectorImpl#selectedKeys`集合中，这时`Reactor线程`会从`java.nio.channels.Selector#select(long)`阻塞调用中返回（类似上篇文章提到的`epoll_wait`）。
- **遍历操作：**`Reactor线程`返回后，会从`Selector`中获取`IO就绪`的`SelectionKey`集合（也就是`sun.nio.ch.SelectorImpl#selectedKeys`），`Reactor线程`**遍历**`selectedKeys`,获取`IO就绪`的`SocketChannel`，并处理`SocketChannel`上的`IO事件`。

我们都知道`HashSet`底层数据结构是一个`哈希表`，由于`Hash冲突`这种情况的存在，所以导致对`哈希表`进行`插入`和`遍历`操作的性能不如对`数组`进行`插入`和`遍历`操作的性能好。

还有一个重要原因是，数组可以利用 CPU 缓存的优势来提高遍历的效率。后面笔者会有一篇专门的文章来讲述利用 CPU 缓存行如何为我们带来性能优势。

所以 Netty 为了优化对`sun.nio.ch.SelectorImpl#selectedKeys`集合的`插入，遍历`性能，自己用`数组`这种数据结构实现了`SelectedSelectionKeySet`，用它来替换原来的`HashSet`实现。

### SelectedSelectionKeySet

优势如下：

- 初始化`SelectionKey[] keys`数组大小为`1024`，当数组容量不够时，扩容为原来的两倍大小。
- 通过数组尾部指针`size`，在向数组插入元素的时候可以直接定位到插入位置`keys[size++]`。操作一步到位，不用像`哈希表`那样还需要解决`Hash冲突`。
- 对数组的遍历操作也是如丝般顺滑，CPU 直接可以在缓存行中遍历读取数组元素无需访问内存。比`HashSet`的迭代器`java.util.HashMap.KeyIterator` 遍历方式性能不知高到哪里去了。

```java
final class SelectedSelectionKeySet extends AbstractSet<SelectionKey> {

    //采用数组替换到JDK中的HashSet,这样add操作和遍历操作效率更高，不需要考虑hash冲突
    SelectionKey[] keys;
    //数组尾部指针
    int size;

    SelectedSelectionKeySet() {
        keys = new SelectionKey[1024];
    }

    /**
     * 数组的添加效率高于 HashSet 因为不需要考虑hash冲突
     * */
    @Override
    public boolean add(SelectionKey o) {
        if (o == null) {
            return false;
        }
        //时间复杂度O（1）
        keys[size++] = o;
        if (size == keys.length) {
            //扩容为原来的两倍大小
            increaseCapacity();
        }

        return true;
    }

    private void increaseCapacity() {
        SelectionKey[] newKeys = new SelectionKey[keys.length << 1];
        System.arraycopy(keys, 0, newKeys, 0, size);
        keys = newKeys;
    }

    /**
     * 采用数组的遍历效率 高于 HashSet
     * */
    @Override
    public Iterator<SelectionKey> iterator() {
        return new Iterator<SelectionKey>() {
            private int idx;

            @Override
            public boolean hasNext() {
                return idx < size;
            }

            @Override
            public SelectionKey next() {
                if (!hasNext()) {
                    throw new NoSuchElementException();
                }
                return keys[idx++];
            }

            @Override
            public void remove() {
                throw new UnsupportedOperationException();
            }
        };
    }
}
```

看到这里不禁感叹，从各种小的细节可以看出 Netty 对性能的优化简直淋漓尽致，对性能的追求令人发指。细节真的是魔鬼。

4. Netty 通过反射的方式用`SelectedSelectionKeySet`替换掉`sun.nio.ch.SelectorImpl#selectedKeys`，`sun.nio.ch.SelectorImpl#publicSelectedKeys`这两个集合中原来`HashSet`的实现。

- 反射获取`sun.nio.ch.SelectorImpl`类中`selectedKeys`和`publicSelectedKeys`。

```java
Field selectedKeysField = selectorImplClass.getDeclaredField("selectedKeys");
  Field publicSelectedKeysField = selectorImplClass.getDeclaredField("publicSelectedKeys");
```

- `Java9`版本以上通过`sun.misc.Unsafe`设置字段值的方式

```java
if (PlatformDependent.javaVersion() >= 9 && PlatformDependent.hasUnsafe()) {

    long selectedKeysFieldOffset = PlatformDependent.objectFieldOffset(selectedKeysField);
    long publicSelectedKeysFieldOffset =
            PlatformDependent.objectFieldOffset(publicSelectedKeysField);

    if (selectedKeysFieldOffset != -1 && publicSelectedKeysFieldOffset != -1) {
        PlatformDependent.putObject(
                unwrappedSelector, selectedKeysFieldOffset, selectedKeySet);
        PlatformDependent.putObject(
                unwrappedSelector, publicSelectedKeysFieldOffset, selectedKeySet);
        return null;
    }

}
```

- 通过反射的方式用`SelectedSelectionKeySet`替换掉`hashSet`实现的`sun.nio.ch.SelectorImpl#selectedKeys，sun.nio.ch.SelectorImpl#publicSelectedKeys`。

```java
Throwable cause = ReflectionUtil.trySetAccessible(selectedKeysField, true);
if (cause != null) {
    return cause;
}
cause = ReflectionUtil.trySetAccessible(publicSelectedKeysField, true);
if (cause != null) {
    return cause;
}
//Java8反射替换字段
selectedKeysField.set(unwrappedSelector, selectedKeySet);
publicSelectedKeysField.set(unwrappedSelector, selectedKeySet);
```

5. 将与`sun.nio.ch.SelectorImpl`类中`selectedKeys`和`publicSelectedKeys`关联好的 Netty 优化实现`SelectedSelectionKeySet`，设置到`io.netty.channel.nio.NioEventLoop#selectedKeys`字段中保存。

```java
//会通过反射替换selector对象中的selectedKeySet保存就绪的selectKey
//该字段为持有selector对象selectedKeys的引用，当IO事件就绪时，直接从这里获取
private SelectedSelectionKeySet selectedKeys;
```

后续`Reactor线程`就会直接从`io.netty.channel.nio.NioEventLoop#selectedKeys`中获取`IO就绪`的`SocketChannel`

6. 用`SelectorTuple`封装`unwrappedSelector`和`wrappedSelector`返回给`NioEventLoop`构造函数。到此`Reactor`中的`Selector`就创建完毕了。

```java
return new SelectorTuple(unwrappedSelector,
                      new SelectedSelectionKeySetSelector(unwrappedSelector, selectedKeySet));
private static final class SelectorTuple {
    final Selector unwrappedSelector;
    final Selector selector;

    SelectorTuple(Selector unwrappedSelector) {
        this.unwrappedSelector = unwrappedSelector;
        this.selector = unwrappedSelector;
    }

    SelectorTuple(Selector unwrappedSelector, Selector selector) {
        this.unwrappedSelector = unwrappedSelector;
        this.selector = selector;
    }
}
```

- 所谓的`unwrappedSelector`是指被 Netty 优化过的 JDK NIO 原生 Selector。
- 所谓的`wrappedSelector`就是用`SelectedSelectionKeySetSelector`装饰类将`unwrappedSelector`和与`sun.nio.ch.SelectorImpl类`关联好的 Netty 优化实现`SelectedSelectionKeySet`封装装饰起来。

`wrappedSelector`会将所有对`Selector`的操作全部代理给`unwrappedSelector`，并在`发起轮询IO事件`的相关操作中，重置`SelectedSelectionKeySet`清空上一次的轮询结果。

```java
final class SelectedSelectionKeySetSelector extends Selector {
    //Netty优化后的 SelectedKey就绪集合
    private final SelectedSelectionKeySet selectionKeys;
    //优化后的JDK NIO 原生Selector
    private final Selector delegate;

    SelectedSelectionKeySetSelector(Selector delegate, SelectedSelectionKeySet selectionKeys) {
        this.delegate = delegate;
        this.selectionKeys = selectionKeys;
    }

    @Override
    public boolean isOpen() {
        return delegate.isOpen();
    }

    @Override
    public SelectorProvider provider() {
        return delegate.provider();
    }

    @Override
    public Set<SelectionKey> keys() {
        return delegate.keys();
    }

    @Override
    public Set<SelectionKey> selectedKeys() {
        return delegate.selectedKeys();
    }

    @Override
    public int selectNow() throws IOException {
        //重置SelectedKeys集合
        selectionKeys.reset();
        return delegate.selectNow();
    }

    @Override
    public int select(long timeout) throws IOException {
        //重置SelectedKeys集合
        selectionKeys.reset();
        return delegate.select(timeout);
    }

    @Override
    public int select() throws IOException {
        //重置SelectedKeys集合
        selectionKeys.reset();
        return delegate.select();
    }

    @Override
    public Selector wakeup() {
        return delegate.wakeup();
    }

    @Override
    public void close() throws IOException {
        delegate.close();
    }
}
```

## processSelectedKeys

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301622553.png)

回到我们开头提到的代码，从这俩方法的签名我们就可以看出一个是优化过的事件处理器，一个是原生的事件处理器。。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301622326.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301623064.png)

- `**processSelectedKeysPlain**` 适合于简单的实现，容易理解，但在高并发场景下可能会引入性能问题。
- `**processSelectedKeysOptimized**` 则通过直接数组操作来减少内存分配和垃圾回收压力，从而提高性能。特别是在高负载情况下，优化的方法能够显著提高处理效率。

### processSelectedKey

```java
private void processSelectedKey(SelectionKey k, AbstractNioChannel ch) {
    final AbstractNioChannel.NioUnsafe unsafe = ch.unsafe();
    if (!k.isValid()) {
        final EventLoop eventLoop;
        try {
            eventLoop = ch.eventLoop();
        } catch (Throwable ignored) {
            // If the channel implementation throws an exception because there is no event loop, we ignore this
            // because we are only trying to determine if ch is registered to this event loop and thus has authority
            // to close ch.
            return;
        }
        // Only close ch if ch is still registered to this EventLoop. ch could have deregistered from the event loop
        // and thus the SelectionKey could be cancelled as part of the deregistration process, but the channel is
        // still healthy and should not be closed.
        // See https://github.com/netty/netty/issues/5125
        if (eventLoop == this) {
            // close the channel if the key is not valid anymore
            unsafe.close(unsafe.voidPromise());
        }
        return;
    }

    try {
        int readyOps = k.readyOps();
        // We first need to call finishConnect() before try to trigger a read(...) or write(...) as otherwise
        // the NIO JDK channel implementation may throw a NotYetConnectedException.
        if ((readyOps & SelectionKey.OP_CONNECT) != 0) {
            // remove OP_CONNECT as otherwise Selector.select(..) will always return without blocking
            // See https://github.com/netty/netty/issues/924
            int ops = k.interestOps();
            ops &= ~SelectionKey.OP_CONNECT;
            k.interestOps(ops);

            unsafe.finishConnect();
        }

        // Process OP_WRITE first as we may be able to write some queued buffers and so free memory.
        if ((readyOps & SelectionKey.OP_WRITE) != 0) {
            // Call forceFlush which will also take care of clear the OP_WRITE once there is nothing left to write
            ch.unsafe().forceFlush();
        }

        // Also check for readOps of 0 to workaround possible JDK bug which may otherwise lead
        // to a spin loop
        if ((readyOps & (SelectionKey.OP_READ | SelectionKey.OP_ACCEPT)) != 0 || readyOps == 0) {
            unsafe.read();
        }
    } catch (CancelledKeyException ignored) {
        unsafe.close(unsafe.voidPromise());
    }
}
```

1. 首先会检测 **key** 是否合法，如果不合法，将关闭其对应的 **Channel**。
2. 使用 `int readyOps = k.readyOps();` 获取此 **Channel** 的 **readyOps**（就绪操作集）。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301623396.png)

3. 判断并处理 **OP_CONNECT** 连接建立事件。此事件表示 **TCP** 连接已成功建立，**Channel** 处于 **Active** 状态。处理 **OP_CONNECT** 事件时，首先将该事件从事件集合中清除，以避免事件集合中一直存在连接建立事件。接着，调用 `unsafe.finishConnect()` 方法通知上层连接已建立。通过查看 `unsafe.finishConnect()` 的源码，可以发现它会底层调用 `pipeline().fireChannelActive()` 方法，这时会产生一个 **Inbound** 事件，并在 **Pipeline** 中进行传播，依次调用 **ChannelHandler** 的 `channelActive()` 方法，通知各个 **ChannelHandler** 连接建立成功。
4. 判断并处理 **OP_WRITE**，可写事件。这表示上层可以向 **Channel** 写入数据。通过执行 `ch.unsafe().forceFlush()` 操作，将数据冲刷到客户端，最终调用 **Java Channel** 的 `write()` 方法执行底层写操作。
5. 判断并处理 **OP_READ**，可读事件。这表示 **Channel** 收到了可以被读取的新数据。**Netty** 将 **READ** 和 **Accept** 事件进行了统一的封装，均通过 `unsafe.read()` 进行处理。`unsafe.read()` 的逻辑可以归纳为几个步骤：
   1. 从 **Channel** 中读取数据并存储到分配的 **ByteBuf**；
   2. 调用 `pipeline.fireChannelRead()` 方法产生 **Inbound** 事件，然后依次调用 **ChannelHandler** 的 `channelRead()` 方法处理数据；
   3. 调用 `pipeline.fireChannelReadComplete()` 方法完成读操作；
   4. 最终执行 `removeReadOp()` 清除 **OP_READ** 事件。

Netty 这里使用的判断方法很巧妙`if ((readyOps & SelectionKey.OP_CONNECT) != 0)`，用于判断就绪操作集和连接操作的位与运算是否为 1，如果是，则说明当前就绪操作集中有连接操作。

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301623538.png)

这三行代码旨在取消对 OP_CONNECT 的监听，因为 连接是一次性的操作，一旦连接成功，后续就不需要再关注连接操作。如果在连接成功后不移除 `OP_CONNECT`，那么下次调用 `Selector.select()` 时会无条件返回，因为该键仍然被标记为可连接。这样可能导致无效的轮询和资源浪费。

与连接操作不同，OP_WRITE 和 OP_READ 是可以多次出现的事件。通道可以随时准备好读取或写入数据。

- **OP_WRITE**：通道可能在发送数据后会再次准备好进行写入（例如，发送缓冲区有空余空间）。因此，保持 `OP_WRITE` 状态是合理的，以便能在有新的数据需要写入时及时通知。
- **OP_READ**：通道可以随时准备好读取数据，保持 `OP_READ` 状态可以确保在有新数据到达时，能够及时读取。

::: tip 操作标志的管理

- **动态调整**：对于 `OP_WRITE` 和 `OP_READ`，它们的状态是动态的，可能会在通道的生命周期内多次变化。通过管理这两个状态，可以确保在数据准备好时能够及时进行操作。

* **移除条件**：在某些情况下，当没有更多数据可写或读取时，系统会自动处理 `OP_WRITE` 或 `OP_READ` 的状态，例如使用 `forceFlush()` 来清除 `OP_WRITE` 标志，当没有更多数据可写时，会自动移除该标志。

:::

### needsToSelectAgain

我们再次回到 `processSelectedKeys` 的主流程，接下来会判断 `needsToSelectAgain` 决定是否需要重新轮询。如果 `needsToSelectAgain == true`，会调用 `selectAgain()` 方法进行重新轮询，该方法会将 `needsToSelectAgain` 再次置为 `false`，然后调用 `selectorNow()` 后立即返回。

我们回顾一下 Reactor 线程的主流程，会发现每次在处理 I/O 事件之前，`needsToSelectAgain` 都会被设置为 `false`。那么，在什么场景下 `needsToSelectAgain` 会再次设置为 `true` 呢？我们通过查找变量的引用，最终定位到 `AbstractChannel#doDeregister`。该方法的作用是将 `Channel` 从当前注册的 `Selector` 对象中移除，方法内部可能会把 `needsToSelectAgain` 设置为 `true`，具体源码如下：

```java
protected void doDeregister() throws Exception {
    eventLoop().cancel(selectionKey());
}

void cancel(SelectionKey key) {
    key.cancel();

    cancelledKeys ++;

    // 当取消的 Key 超过默认阈值 256，needsToSelectAgain 设置为 true
    if (cancelledKeys >= CLEANUP_INTERVAL) {
        cancelledKeys = 0;
        needsToSelectAgain = true;
    }
}
```

当 **Netty** 在处理 I/O 事件的过程中，如果发现超过默认阈值 **256** 个 **Channel** 从 **Selector** 对象中移除后，会将 `needsToSelectAgain` 设置为 `true`，重新做一次轮询操作，从而确保 `keySet` 的有效性。

## 对四种 IO 事件的理解

`java.nio.channels` 包中，`SelectionKey` 抽象类定义了四种 I/O 操作：

- **`public static final int OP_READ = 1 << 0;`**
  用于读取操作的操作设置位。假设选择键的兴趣集在选择操作开始时包含 `OP_READ`。如果选择器检测到相应的通道已准备好读取、已到达流末尾、已远程关闭以供进一步读取或有待处理错误，则它会将 `OP_READ` 添加到密钥的就绪操作集中，并将密钥添加到其选定的密钥集中。
- **`public static final int OP_WRITE = 1 << 2;`**
  用于写入操作的操作设置位。假设选择键的兴趣集在选择操作开始时包含 `OP_WRITE`。如果选择器检测到相应的通道已准备好写入、已被远程关闭以进行进一步写入，或者有待处理的错误，那么它会将 `OP_WRITE` 添加到键的就绪集，并将键添加到其选定的键集中。
- **`public static final int OP_CONNECT = 1 << 3;`**
  用于套接字连接操作的操作设置位。假设选择键的兴趣集在选择操作开始时包含 `OP_CONNECT`。如果选择器检测到相应的 socket 通道已准备好完成其连接序列，或者有一个待处理的错误，那么它会将 `OP_CONNECT` 添加到键的就绪集，并将键添加到其选定的键集中。
- **`public static final int OP_ACCEPT = 1 << 4;`**
  用于 socket accept 操作的操作设置位。假设选择键的兴趣集在选择操作开始时包含 `OP_ACCEPT`。如果选择器检测到相应的 server-socket 通道已准备好接受另一个连接，或者有一个待处理的错误，那么它会将 `OP_ACCEPT` 添加到键的就绪集，并将键添加到其选定的键集中。

### NioServerSocketChannel 对应事件

#### OP_ACCEPT

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301623590.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301623732.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301623934.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301624351.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301624060.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301624541.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301624940.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301624915.png)

### NioSocketChannel 对应事件

#### OP_READ

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301624248.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301624739.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301625447.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301625051.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301625958.png)

![image-20241101004318396](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411010043448.png)

#### OP_WRITE

当我们在代码中调用 flush 时，也就是将我们要写入 IO 的数据从用户态中的缓冲区刷入 TCP 缓冲区中，因为 TCP 通过滑动窗口机制去控制它的发送方的发送速度，所以当接收方以及网络传输速度跟不上发送方发送数据的速度时，发送方的 TCP 缓冲区就会被打满，这时候我们的 flush 就会失效，因为内核 TCP 缓冲区已经被打满了，再怎么写也写不进去数据，然后这时候 Netty 捕捉到了这个“异常”，就会对当前文件描述符注册 OP_WRITE 事件，当其缓冲区能写入数据的时候，会产生 OP_WRITE 事件，然后我们的 Netty 中的 selector 就会捕获到此事件，然后我们会再次将用户态中的数据刷到内核中的 TCP 缓冲区

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301625449.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301625744.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301625346.png)

#### OP_CONNECT

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301626408.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301626453.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301626511.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301626471.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301626660.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301626834.png)

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410301627580.png)

## 总结

本文简单说明了 Netty 对 Java NIO 的优化，以及 Netty 如何分类处理 IO 事件的
