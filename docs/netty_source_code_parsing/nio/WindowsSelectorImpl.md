# WindowsSelectorImpl源码分析

## 初始化WindowsSelectorProvider

上一篇文章提到，若没有进行配置时，默认通过`sun.nio.ch.DefaultSelectorProvider.create()`创建`SelectorProvider`。
Windows下的代码路径在`jdk\src\windows\classes\sun\nio\ch\DefaultSelectorProvider.java`。在其内部通过实际是创建了一个`WindowsSelectorProvider)`。

## 创建WindowsSelectorImpl

`WindowsSelectorProvider`是用于创建`WindowsSelectorImpl`的。

```java
Selector.Open()->
SelectorProvider.provider()->
sun.nio.ch.DefaultSelectorProvider.create()->
new WindowsSelectorImpl(this)->
WindowsSelectorProvider.openSelector()
public class WindowsSelectorProvider extends SelectorProviderImpl {
 
    public AbstractSelector openSelector() throws IOException {
        return new WindowsSelectorImpl(this);
    }
}
```

## WindowsSelectorImpl结构

在详细讲解`WindowsSelectorImpl`源码之前，先了解`WindowsSelectorImpl`的大致代码结构。

在其内部有几个主要的数据结构和属性。

| 名称                            | 作用                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| SelectionKeyImpl[] channelArray | 存放注册的SelectionKey                                       |
| PollArrayWrapper pollWrapper    | 底层的本机轮询数组包装对象，用于存放Socket文件描述符和事件掩码 |
| List\<SelectThread\> threads    | 辅助线程，多个线程有助于提高高并发时的性能                   |
| Pipe wakeupPipe                 | 用于唤醒辅助线程                                             |
| FdMap fdMap                     | 保存文件描述符和SelectionKey的映射关系                       |
| SubSelector subSelector         | 调用JNI的poll和处理就绪的SelectionKey                        |
| StartLock startLock             | 新增的辅助线程使用该锁等待主线程的开始信号                   |
| FinishLock finishLock           | 主线程用该锁等待所有辅助线程执行完毕                         |
|                                 |                                                              |

### SelectionKeyImpl

用于存放`Channel`,`Selector`以及存放Channel注册时的事件掩码。

- 在注册的时候会创建`SelectionKeyImpl`
- 将`SelectionKeyImpl`加入到`SelectionKeyImpl[] channelArray`
- 将文件句柄和`SelectionKeyImpl`的对应关系加入到`FdMap fdMap`
- 将key的文件描述符保存到`PollArrayWrapper pollWrapper`中。

### PollArrayWrapper

`PollArrayWrapper`用于存放文件描述符的文件描述符和事件掩码的native数组。相关的文件描述符的结构如下图：

![img](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411071454063.png)

其中每项的结构如下：

| 名称           | 大小  | 说明                             |
| -------------- | ----- | -------------------------------- |
| SOCKET fd      | 4字节 | 存放Socket文件句柄               |
| short events   | 2字节 | 等待的事件掩码                   |
| short reevents | 2字节 | 实际发生的事件掩码，暂时美有用到 |

如上所示，每项为8字节，即为`SIZE_POLLFD`的值，目前NIO实际只用前两个字段。

```java
class PollArrayWrapper {
    private AllocatedNativeObject pollArray; // The fd array
    long pollArrayAddress; // pollArrayAddress
    static short SIZE_POLLFD = 8; // sizeof pollfd struct
    private int size; // Size of the pollArray
    PollArrayWrapper(int newSize) {
        int allocationSize = newSize * SIZE_POLLFD;
        pollArray = new AllocatedNativeObject(allocationSize, true);
        pollArrayAddress = pollArray.address();
        this.size = newSize;
    }
...
}
```

在 `PollArrayWrapper` 内部使用 `AllocatedNativeObject`对象创建的堆外(native)内存对象。
将数组的首地址保存到`pollArrayAddress`中，**在调用`Poll`的时候需要传递该参数给JNI**。

`PollArrayWrapper`暴露了读写FD和Event的方法供`WindowsSelectorImpl`使用。

```java
void putDescriptor(int i, int fd) {
    pollArray.putInt(SIZE_POLLFD * i + FD_OFFSET, fd);
}
 
void putEventOps(int i, int event) {
    pollArray.putShort(SIZE_POLLFD * i + EVENT_OFFSET, (short)event);
}
 
int getEventOps(int i) {
    return pollArray.getShort(SIZE_POLLFD * i + EVENT_OFFSET);
}
 
int getDescriptor(int i) {
    return pollArray.getInt(SIZE_POLLFD * i + FD_OFFSET);
}
 
```

### SelectThread

由于select最大一次性获取1024个文件描述符。因此为了提高poll的性能
`WindowsSelectorImpl`底层 **通过引入多个辅助线程的方式实现多线程poll以提高高并发时的性能问题。** 我们先看一下注册的逻辑

```java
protected void implRegister(SelectionKeyImpl ski) {
    synchronized (closeLock) {
        if (pollWrapper == null)
            throw new ClosedSelectorException();
        //判断是否需要扩容队列以及添加辅助线程
        growIfNeeded();
        //保存到缓存中
        channelArray[totalChannels] = ski;
        //保存在数组中的位置
        ski.setIndex(totalChannels);
        //保存文件描述符和SelectionKeyImpl的映射关系到FDMap
        fdMap.put(ski);
        //保存到keys中
        keys.add(ski);
        //保存文件描述符和事件到native数组中
        pollWrapper.addEntry(totalChannels, ski);
        totalChannels++;
    }
}
```

在注册之前会先会判断当前注册的`Channel`数量 **是否达到需要启动辅助线程的阈值**。如果达到阈值则需要扩容`pollWrapper`数组，同时还要 **将`wakeupSourceFd`加入到扩容后的第一个位置** （具体作用下面会讲解）。

```java
private void growIfNeeded() {
    if (channelArray.length == totalChannels) {
        //channel数组已满,扩容两倍
        int newSize = totalChannels * 2; // Make a larger array
        SelectionKeyImpl temp[] = new SelectionKeyImpl[newSize];
        System.arraycopy(channelArray, 1, temp, 1, totalChannels - 1);
        channelArray = temp;
        //文件描述符数组扩容
        pollWrapper.grow(newSize);
    }
    //达到最大文件描述符数量时添加辅助线程
    if (totalChannels % MAX_SELECTABLE_FDS == 0) { // more threads needed
        //将唤醒的文件描述符加入到扩容后的第一个位置。
        pollWrapper.addWakeupSocket(wakeupSourceFd, totalChannels);
        totalChannels++;
        //添加线程数
        threadsCount++;
    }
}
```

扩容`PollArrayWrapper`

```java
pollWrapper.grow(newSize);
void grow(int newSize) {
    //创建新的数组
    PollArrayWrapper temp = new PollArrayWrapper(newSize);
    for (int i = 0; i < size; i++)
    //将原来的数组的内容存放到新的数组中
        replaceEntry(this, i, temp, i);
    //释放原来的数组
    pollArray.free();
    //更新引用
    pollArray = temp.pollArray;
    //更新大小
    this.size = temp.size;
    //更新地址
    pollArrayAddress = pollArray.address();
}
```

扩容完成时，需要添加一个辅助线程以并行的处理所有文件描述符。**主线程处理前1024个文件描述符，第二个辅助线程处理1025到2048的文件描述符，以此类推。** 这样使得主线程调用poll的时候，通过多线程并行执行一次性获取到所有的已就绪的文件描述符，从而提高在高并发时的poll的性能。

每1024个PollFD的第一个句柄都要设置为`wakeupSourceFd`，因此在扩容的时候也需要将新的位置的第一个设置为`wakeupSourceFd`，该线程的目的是为了**唤醒辅助线程** 。当多个线程阻塞在`Poll`，若此时主线程已经处理完成，则需要等待所有辅助线程完成，通过向`wakeupSourceFd`发送信号以激活`Poll`不在阻塞。

现在我们知道了windows下poll多线程的使用方法，因为多线程poll还需要其他的数据结构支持同步，具体的多线程执行逻辑我们下面再讨论。

### FdMap

FDMap只是为了保存文件描述符句柄和`SelectionKey`的关系，前面我们提到了PollFD的数据结构包含了文件描述符句柄信息，因此我们可以通过文件描述符句柄从FdMap中获取到对应的`SelectionKey`。

```java
private final static class FdMap extends HashMap<Integer, MapEntry> {
    static final long serialVersionUID = 0L;
    private MapEntry get(int desc) {
        return get(new Integer(desc));
    }
    private MapEntry put(SelectionKeyImpl ski) {
        return put(new Integer(ski.channel.getFDVal()), new MapEntry(ski));
    }
    private MapEntry remove(SelectionKeyImpl ski) {
        Integer fd = new Integer(ski.channel.getFDVal());
        MapEntry x = get(fd);
        if ((x != null) && (x.ski.channel == ski.channel))
            return remove(fd);
        return null;
    }
}
```

### SubSelector

`SubSelector`封装了调用JNI poll的逻辑，以及获取就绪`SelectionKey`的方法。

主线程和每一个子线程都有一个`SubSelector`，其内存保存了poll获取到的可读文件描述符，可写文件描述符以及异常的文件描述符。这样每个线程就有自己单独的就绪文件描述符数组。

```java
 
private final int pollArrayIndex;
private final int[] readFds = new int [MAX_SELECTABLE_FDS + 1];
private final int[] writeFds = new int [MAX_SELECTABLE_FDS + 1];
private final int[] exceptFds = new int [MAX_SELECTABLE_FDS + 1];
 
```

`pollArrayIndex`记录了当前`SubSelector`的序号，在调用poll的时候，需要将文件描述符数组的地址传递给JNI中，由于我们有多个线程一起调用poll，且每个线程处理1024个`Channel`。通过序号和数组的地址计算当前`SubSelector`所负责哪些通道。

```java
private int poll() throws IOException{ // poll for the main thread
    return poll0(pollWrapper.pollArrayAddress,
                    Math.min(totalChannels, MAX_SELECTABLE_FDS),
                    readFds, writeFds, exceptFds, timeout);
}
 
private int poll(int index) throws IOException {
    // poll for helper threads
    return  poll0(pollWrapper.pollArrayAddress +
                (pollArrayIndex * PollArrayWrapper.SIZE_POLLFD),
                Math.min(MAX_SELECTABLE_FDS,
                        totalChannels - (index + 1) * MAX_SELECTABLE_FDS),
                readFds, writeFds, exceptFds, timeout);
}
 
private native int poll0(long pollAddress, int numfds,
        int[] readFds, int[] writeFds, int[] exceptFds, long timeout);
 
```

在主线程调用poll之后，会获取到已就绪的文件描述符(包含可读、可写、异常)。通过调用`processSelectedKeys`将就绪的文件描述符对应的`SelectorKey`加入到`selectedKeys`中。这样我们外部就可以调用到所有就绪的`SelectorKey`进行遍历处理。

```java
private int processSelectedKeys(long updateCount) {
    int numKeysUpdated = 0;
    numKeysUpdated += processFDSet(updateCount, readFds,
                                    Net.POLLIN,
                                    false);
    numKeysUpdated += processFDSet(updateCount, writeFds,
                                    Net.POLLCONN |
                                    Net.POLLOUT,
                                    false);
    numKeysUpdated += processFDSet(updateCount, exceptFds,
                                    Net.POLLIN |
                                    Net.POLLCONN |
                                    Net.POLLOUT,
                                    true);
    return numKeysUpdated;
}
```

可读文件描述符，可写文件描述符以及异常文件描述符的处理逻辑都是一样的，调用`processFDSet`处理更新`SelectorKey`的就绪事件。这里会传入文件描述符的数组。需要注意的是**文件描述符第一个元素是数组的长度。**

```java
private int processFDSet(long updateCount, int[] fds, int rOps, boolean isExceptFds)
{
    int numKeysUpdated = 0;
    //1. 遍历文件描述符数组
    for (int i = 1; i <= fds[0]; i++) {
        //获取文件描述符句柄值
        int desc = fds[i];
        //2. 判断当前文件描述符是否是用于唤醒的文件描述
        if (desc == wakeupSourceFd) {
            synchronized (interruptLock) {
                interruptTriggered = true;
            }
            continue;
        }
        //3. 获取文件描述符句柄对应的SelectionKey的映射值
        MapEntry me = fdMap.get(desc);
        // 4. 若为空，则表示已经被取消。
        if (me == null)
            continue;
        SelectionKeyImpl sk = me.ski;
 
        // 5. 丢弃OOD数据(紧急数据)
        if (isExceptFds &&
            (sk.channel() instanceof SocketChannelImpl) &&
            discardUrgentData(desc))
        {
            continue;
        }
        //6. 判断key是否已经就绪，若已就绪，则将当前操作累加到原来的操作上，比如原来写事件就绪，现在读事件就绪，就需要更新该key读写就绪
        if (selectedKeys.contains(sk)) { // Key in selected set
        //clearedCount 和 updateCount用于避免同一个key的事件设置多次，因为同一个文件描述符可能在可读文件描述符数组也可能在异常文件描述符数组中。
            if (me.clearedCount != updateCount) {
                if (sk.channel.translateAndSetReadyOps(rOps, sk) &&
                    (me.updateCount != updateCount)) {
                    me.updateCount = updateCount;
                    numKeysUpdated++;
                }
            } else { // The readyOps have been set; now add
                if (sk.channel.translateAndUpdateReadyOps(rOps, sk) &&
                    (me.updateCount != updateCount)) {
                    me.updateCount = updateCount;
                    numKeysUpdated++;
                }
            }
            me.clearedCount = updateCount;
        } else { // Key is not in selected set yet
        //key原来未就绪，将key加入selectedKeys中
            if (me.clearedCount != updateCount) {
                sk.channel.translateAndSetReadyOps(rOps, sk);
                if ((sk.nioReadyOps() & sk.nioInterestOps()) != 0) {
                    selectedKeys.add(sk);
                    me.updateCount = updateCount;
                    numKeysUpdated++;
                }
            } else { // The readyOps have been set; now add
                sk.channel.translateAndUpdateReadyOps(rOps, sk);
                if ((sk.nioReadyOps() & sk.nioInterestOps()) != 0) {
                    selectedKeys.add(sk);
                    me.updateCount = updateCount;
                    numKeysUpdated++;
                }
            }
            me.clearedCount = updateCount;
        }
    }
    return numKeysUpdated;
}
 
```

1. 首先忽略`wakeupSourceFd`,前面说了该文件描述符用于唤醒。
2. 过滤fdMap不存在的文件描述符，这些文件描述符已经被取消了。
3. 忽略OOB(紧急)数据，这些数据需要调用`discardUrgentData`读取并忽略。
4. 根据key是否在SelectorKeys中决定是设置事件掩码还是更新事件掩码。

## 多线程Poll

现在大部分数据结构都已经介绍了，在谈论Pipe、StartLock和FinishLock之前，是时候引入多线程Poll功能了，在谈论多线程时，会对上述三个数据结构和功能进行详细说明。

首先我们先看一下创建`WindowsSelectorImpl`做了什么

```java
 
WindowsSelectorImpl(SelectorProvider sp) throws IOException {
    super(sp);
    pollWrapper = new PollArrayWrapper(INIT_CAP);
    wakeupPipe = Pipe.open();
    wakeupSourceFd = ((SelChImpl)wakeupPipe.source()).getFDVal();
 
    // Disable the Nagle algorithm so that the wakeup is more immediate
    SinkChannelImpl sink = (SinkChannelImpl)wakeupPipe.sink();
    (sink.sc).socket().setTcpNoDelay(true);
    wakeupSinkFd = ((SelChImpl)sink).getFDVal();
 
    pollWrapper.addWakeupSocket(wakeupSourceFd, 0);
}
```

1. 首先创建了一个默认8个长度(8*8字节)的文件描述符数组`PollArrayWrapper`
2. 创建一个Pipe，Pipe我们之前讨论过是一个单向通讯管道。
3. 获取Pipe的源端和目标端的文件描述符句柄，该句柄用于激活线程。
4. 将`wakeupSourceFd`存到`PollArrayWapper`每1024个元素的第一个位置。使得每个线程都能被`wakeupSourceFd`唤醒。

由于select最大支持1024个句柄，这里第一个文件描述符是`wakeupSourceFd`，所以一个线程实际最多并发处理1023个socket文件描述符。

```java
pollWrapper.addWakeupSocket(wakeupSourceFd, 0);
void addWakeupSocket(int fdVal, int index) {
    putDescriptor(index, fdVal);
    putEventOps(index, Net.POLLIN);
}
```

现在我们看一下doSelect逻辑

```java
 
protected int doSelect(long timeout) throws IOException {
    if (channelArray == null)
            throw new ClosedSelectorException();
    this.timeout = timeout; // set selector timeout
    //1. 删除取消的key
    processDeregisterQueue();
    if (interruptTriggered) {
        resetWakeupSocket();
        return 0;
    }
    //2. 调整线程数 ，等待运行
    adjustThreadsCount();
    //3. 设置辅助线程数
    finishLock.reset(); 
    //4. 开始运行新增的辅助线程
    startLock.startThreads();
    
    try {
        begin();
        try {
            //5. 获取就绪文件描述符
            subSelector.poll();
        } catch (IOException e) {
            finishLock.setException(e); // Save this exception
        }
        //6. 等待所有辅助线程完成
        if (threads.size() > 0)
            finishLock.waitForHelperThreads();
        } finally {
            end();
        }
    // Done with poll(). Set wakeupSocket to nonsignaled  for the next run.
    finishLock.checkForException();
    //7. 再次检查删除取消的key
    processDeregisterQueue();
    //8. 将就绪的key加入到selectedKeys中
    int updated = updateSelectedKeys();
    // 完成，重置唤醒标记下次在运行。
    resetWakeupSocket();
    return updated;
}
```

1. 删除取消key,当channel关闭时，对应的Key会被取消,被取消的key会加入到`cancelledKeys`中。

```java
protected final void implCloseChannel() throws IOException {
    implCloseSelectableChannel();
    synchronized (keyLock) {
        int count = (keys == null) ? 0 : keys.length;
        for (int i = 0; i < count; i++) {
            SelectionKey k = keys[i];
            if (k != null)
                k.cancel();
        }
    }
}
public final void cancel() {
    ...
    ((AbstractSelector)selector()).cancel(this);
    ...
}
void cancel(SelectionKey k) {                       // package-private
    synchronized (cancelledKeys) {
        cancelledKeys.add(k);
    }
}
```

调用`processDeregisterQueue`进行注销。

```java
processDeregisterQueue();
//遍历所有已取消的key，取消他们
void processDeregisterQueue() throws IOException {
    // Precondition: Synchronized on this, keys, and selectedKeys
    Set<SelectionKey> cks = cancelledKeys();
    synchronized (cks) {
        if (!cks.isEmpty()) {
            //遍历所有key
            Iterator<SelectionKey> i = cks.iterator();
            while (i.hasNext()) {
                SelectionKeyImpl ski = (SelectionKeyImpl)i.next();
                try {
                    //注销key
                    implDereg(ski);
                } catch (SocketException se) {
                    throw new IOException("Error deregistering key", se);
                } finally {
                    i.remove();
                }
            }
        }
    }
}
protected void implDereg(SelectionKeyImpl ski) throws IOException{
    int i = ski.getIndex();
    assert (i >= 0);
    synchronized (closeLock) {
        if (i != totalChannels - 1) {
            // 把最后一个通道复制到取消key所在的位置。
            SelectionKeyImpl endChannel = channelArray[totalChannels-1];
            channelArray[i] = endChannel;
            endChannel.setIndex(i);
            pollWrapper.replaceEntry(pollWrapper, totalChannels - 1,
                                                            pollWrapper, i);
        }
        ski.setIndex(-1);
    }
    //将最后一个通道清空。
    channelArray[totalChannels - 1] = null;
    totalChannels--;
    //判断是否需要减少一个辅助线程。
    if ( totalChannels != 1 && totalChannels % MAX_SELECTABLE_FDS == 1) {
        totalChannels--;
        threadsCount--; // The last thread has become redundant.
    }
    //清除对应的缓存。
    fdMap.remove(ski); // Remove the key from fdMap, keys and selectedKeys
    keys.remove(ski);
    selectedKeys.remove(ski);
    //设置key无效
    deregister(ski);
    SelectableChannel selch = ski.channel();
    if (!selch.isOpen() && !selch.isRegistered())
    //关闭文件描述符
        ((SelChImpl)selch).kill();
}
//将所有key都设置为无效
protected final void deregister(AbstractSelectionKey key) {
        ((AbstractSelectableChannel)key.channel()).removeKey(key);
    }
    void removeKey(SelectionKey k) {                    // package-private
        synchronized (keyLock) {
            for (int i = 0; i < keys.length; i++)
                if (keys[i] == k) {
                    keys[i] = null;
                    keyCount--;
                }
            //将key设置为无效
            ((AbstractSelectionKey)k).invalidate();
        }
    }
 
```

- 取消时首先会将该Key的文件描述符的PollFD项从pollWrapper中移除。
- 将key从`channelArray`中删除。
- 若总的注册通道数达到了减小线程的阈值，则减小一个线程。
- 清理`fdMap`、`keys`、`selectedKeys`数据缓存。
- 设置key无效
- 关闭文件描述符

`((SelChImpl)selch).kill();`是在各个Channel中实现的，以SocketChannel为例,最终会调用`nd.close(fd);`关闭对应的文件描述符

1. 调整辅助线程数

```java
private void adjustThreadsCount() {
    //当线程大于实际线程，创建更多线程
    if (threadsCount > threads.size()) {
        // More threads needed. Start more threads.
        for (int i = threads.size(); i < threadsCount; i++) {
            SelectThread newThread = new SelectThread(i);
            threads.add(newThread);
            //设置为守护线程
            newThread.setDaemon(true);
            newThread.start();
        }
    } else if (threadsCount < threads.size()) {
        // 当线程小于实际线程，移除线程。
        for (int i = threads.size() - 1 ; i >= threadsCount; i--)
            threads.remove(i).makeZombie();
    }
}
 
```

在创建新的线程时，会记录上一次运行的数量保存到`lastRun`变量中

```java
private SelectThread(int i) {
        this.index = i;
        this.subSelector = new SubSelector(i);
        //make sure we wait for next round of poll
        this.lastRun = startLock.runsCounter;
    }
```

当线程启动时会等待主线程激活

```java
 
public void run() {
    while (true) { // poll loop
        //等待主线程信号激活
        if (startLock.waitForStart(this))
            return;
        // call poll()
        try {
            subSelector.poll(index);
        } catch (IOException e) {
            // Save this exception and let other threads finish.
            finishLock.setException(e);
        }
        // 通知主线程完成.
        finishLock.threadFinished();
    }
}
```

通过`startLock`等待主线程的开始信号。若当前线程是新启动的线程，则`runsCounter == thread.lastRun`为真，此时新的线程需要等待主线程调用启动。

```java
startLock.waitForStart(this)
private synchronized boolean waitForStart(SelectThread thread) {
        while (true) {
            while (runsCounter == thread.lastRun) {
                try {
                    startLock.wait();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            if (thread.isZombie()) { // redundant thread
                return true; // will cause run() to exit.
            } else {
                thread.lastRun = runsCounter; // update lastRun
                return false; //   will cause run() to poll.
            }
        }
    }
}
```

1. 设置辅助线程数量

记录当前辅助线程数量，下次新增的辅助线程需要等待主线程通知启动。

```java
finishLock.reset(); 
private void reset() {
    threadsToFinish = threads.size(); // helper threads
}
```

1. 开始运行新增的辅助线程

```java
startLock.startThreads();
private synchronized void startThreads() {
    runsCounter++; // next run
    notifyAll(); // 通知所有辅助线程继续执行，
}
```

1. 获取已就绪的文件描述符

```java
subSelector.poll();
//主线程调用
private int poll() throws IOException{ 
    return poll0(pollWrapper.pollArrayAddress,
                    Math.min(totalChannels, MAX_SELECTABLE_FDS),
                    readFds, writeFds, exceptFds, timeout);
}
//辅助线程调用
private int poll(int index) throws IOException {
 
    return  poll0(pollWrapper.pollArrayAddress +
                (pollArrayIndex * PollArrayWrapper.SIZE_POLLFD),
                Math.min(MAX_SELECTABLE_FDS,
                        totalChannels - (index + 1) * MAX_SELECTABLE_FDS),
                readFds, writeFds, exceptFds, timeout);
}
```

辅助线程和主线程调用的区别就是存放PollFD的位置变化，每个线程会有1024个PollFD(8B)的位置存放PollFD。这样使得多个线程的数据内存分离互不影响。
下面看一下JNI的`poll0`做了什么处理。下面罗略了主要的逻辑

```java
 
typedef struct {
    jint fd;
    jshort events;
} pollfd;
 
Java_sun_nio_ch_WindowsSelectorImpl_00024SubSelector_poll0(JNIEnv *env, jobject this,
                                   jlong pollAddress, jint numfds,
                                   jintArray returnReadFds, jintArray returnWriteFds,
                                   jintArray returnExceptFds, jlong timeout)
{
    DWORD result = 0;
    pollfd *fds = (pollfd *) pollAddress;
    int i;
    FD_SET readfds, writefds, exceptfds;
    struct timeval timevalue, *tv;
    static struct timeval zerotime = {0, 0};
    ...
    /* Call select */
    if ((result = select(0 , &readfds, &writefds, &exceptfds, tv))
                                                             == SOCKET_ERROR) {
        //当出现错误时，变量每个socket获取它的就绪状态
        FD_SET errreadfds, errwritefds, errexceptfds;
        ...
        for (i = 0; i < numfds; i++) {
            errreadfds.fd_count = 0;
            errwritefds.fd_count = 0;
            if (fds[i].events & POLLIN) {
               errreadfds.fd_array[0] = fds[i].fd;
               errreadfds.fd_count = 1;
            }
            if (fds[i].events & (POLLOUT | POLLCONN))
            {
                errwritefds.fd_array[0] = fds[i].fd;
                errwritefds.fd_count = 1;
            }
            errexceptfds.fd_array[0] = fds[i].fd;
            errexceptfds.fd_count = 1;
            //遍历每个socket，探测它的状态
            /* call select on the i-th socket */
            if (select(0, &errreadfds, &errwritefds, &errexceptfds, &zerotime)
                                                             == SOCKET_ERROR) {
                /* This socket causes an error. Add it to exceptfds set */
                exceptfds.fd_array[exceptfds.fd_count] = fds[i].fd;
                exceptfds.fd_count++;
            } else {
                
                ...
            }
        }
        }
    }
 
    /* Return selected sockets. */
    /* Each Java array consists of sockets count followed by sockets list */
...
    (*env)->SetIntArrayRegion(env, returnReadFds, 0,
                              readfds.fd_count + 1, (jint *)&readfds);
 
    (*env)->SetIntArrayRegion(env, returnWriteFds, 0,
                              writefds.fd_count + 1, (jint *)&writefds);
    (*env)->SetIntArrayRegion(env, returnExceptFds, 0,
                              exceptfds.fd_count + 1, (jint *)&exceptfds);
    return 0;
}
 
```

- 首先会通过`pollfd *fds = (pollfd *) pollAddress;`将pollAddress的地址转换为polldf的数组结构。

> 这里会**自动内存对齐**，pollfd一共只有6个字节，第一个是int类型的文件描述符句柄，第二个是short类型的等待事件掩码值。第二个short后会填充2B，因此每个pollFD是8B。而实际后面2字节用于存放实际发生事件的事件掩码。

- 通过调用Win32API的select执行实际的操作获取就绪的文件描述符。当socket收到OOB(紧急)数据时，会产生异常。此时需要遍历所有文件描述符，以确定是哪个socket接收到OOB数据。从而正常处理。上面也提到过OOB数据会通过调用`discardUrgentData`进行清理。

```Java
JNIEXPORT jboolean JNICALL
Java_sun_nio_ch_WindowsSelectorImpl_discardUrgentData(JNIEnv* env, jobject this,
                                                      jint s)
{
    char data[8];
    jboolean discarded = JNI_FALSE;
    int n;
    do {
        //读取MSG_OOB数据
        n = recv(s, (char*)&data, sizeof(data), MSG_OOB);
        if (n > 0) {
            //读取到设置标记为true
            discarded = JNI_TRUE;
        }
    } while (n > 0);
    return discarded;
}
```

> 如果timeval为{0,0}，则select()立即返回，这可用于探询所选套接口的状态。如果处于这种状态，则select()调用可认为是非阻塞的，且一切适用于非阻塞调用的假设都适用于它。

- 当获取到所有的就绪的文件描述符时，需要保存到返回结果中，同时读写和异常的返回结果的数组第一个为就绪的长度值。
- 等待所有辅助线程完成，当主线程完成时会立即调用`wakeup`向`wakeupSourceFd`发生数据以触发辅助线程唤醒。辅助线程唤醒后也会调用`wakeup`一次。当辅助线程都被唤醒后就会通知主线程。

```java
if (threads.size() > 0)
    finishLock.waitForHelperThreads();
private synchronized void waitForHelperThreads() {
        if (threadsToFinish == threads.size()) {
            // no helper threads finished yet. Wakeup them up.
            wakeup();
        }
        while (threadsToFinish != 0) {
            try {
                finishLock.wait();
            } catch (InterruptedException e) {
                // Interrupted - set interrupted state.
                Thread.currentThread().interrupt();
            }
        }
    }
private synchronized void threadFinished() {
        if (threadsToFinish == threads.size()) { // finished poll() first
            // if finished first, wakeup others
            wakeup();
        }
        threadsToFinish--;
        if (threadsToFinish == 0) // all helper threads finished poll().
            notify();             // notify the main thread
    }
    
```

若辅助线接收到数据，则它需要调用`wakeup`来唤醒其他辅助线程，这样使得主线程火辅助线程至少能调用一次`wakeup`激活其他辅助线程。`wakeup`内部会调用`setWakeupSocket`向`wakeupSourceFd`发生一个信号。

```java
public Selector wakeup() {
    synchronized (interruptLock) {
        if (!interruptTriggered) {
            setWakeupSocket();
            interruptTriggered = true;
        }
    }
    return this;
}
//发生一个字节数据唤醒wakeupsocket
Java_sun_nio_ch_WindowsSelectorImpl_setWakeupSocket0(JNIEnv *env, jclass this,
                                                jint scoutFd)
{
    /* Write one byte into the pipe */
    const char byte = 1;
    send(scoutFd, &byte, 1, 0);
}
```

当主线被激活时，需要调用`resetWakeupSocket`将`wakeupSourceFd`的数据读取出来。

```java
private void resetWakeupSocket() {
        synchronized (interruptLock) {
            if (interruptTriggered == false)
                return;
            resetWakeupSocket0(wakeupSourceFd);
            interruptTriggered = false;
        }
    }
    //读取wakeupsocket的数据。
Java_sun_nio_ch_WindowsSelectorImpl_resetWakeupSocket0(JNIEnv *env, jclass this,
                                            jint scinFd)
{
    char bytes[WAKEUP_SOCKET_BUF_SIZE];
    long bytesToRead;
 
    /* 获取数据大小 */
    ioctlsocket (scinFd, FIONREAD, &bytesToRead);
    if (bytesToRead == 0) {
        return;
    }
    /* 从缓冲区读取所有数据 */
    if (bytesToRead > WAKEUP_SOCKET_BUF_SIZE) {
        char* buf = (char*)malloc(bytesToRead);
        recv(scinFd, buf, bytesToRead, 0);
        free(buf);
    } else {
        recv(scinFd, bytes, WAKEUP_SOCKET_BUF_SIZE, 0);
    }
}
```

> [ioctlsocket()](https://baike.baidu.com/item/ioctlsocket()/10082038?fr=aladdin)是一个计算机函数，功能是控制套接口的模式。可用于任一状态的任一套接口。它用于获取与套接口相关的操作参数，而与具体协议或通讯子系统无关。第二个参数时对socket的操作命令

1. 再次调用删除取消的key
2. 将就绪的key加入到selectKeys中,有多个线程会将所有线程的就绪key加入到selectKeys中。

```java
int updated = updateSelectedKeys();
private int updateSelectedKeys() {
    updateCount++;
    int numKeysUpdated = 0;
    numKeysUpdated += subSelector.processSelectedKeys(updateCount);
    for (SelectThread t: threads) {
        numKeysUpdated += t.subSelector.processSelectedKeys(updateCount);
    }
    return numKeysUpdated;
}
```

若key首次被加入，则会调用`translateAndSetReadyOps`,若key已经在selectKeys中，则会调用`translateAndUpdateReadyOps`。这两个方法都是调用`translateReadyOps`,`translateReadyOps`操作会将已就绪的操作保存。

```java
public boolean translateAndUpdateReadyOps(int ops, SelectionKeyImpl sk) {
    return translateReadyOps(ops, sk.nioReadyOps(), sk);
}
 
public boolean translateAndSetReadyOps(int ops, SelectionKeyImpl sk) {
    return translateReadyOps(ops, 0, sk);
}
 
```

## 关闭WindowsSelectorImpl

关闭WindowsSelectorImpl时会将所有注册的通道一同关闭

```java
protected void implClose() throws IOException {
    synchronized (closeLock) {
        if (channelArray != null) {
            if (pollWrapper != null) {
                // prevent further wakeup
                synchronized (interruptLock) {
                    interruptTriggered = true;
                }
                wakeupPipe.sink().close();
                wakeupPipe.source().close();
                //关闭所有channel
                for(int i = 1; i < totalChannels; i++) { // Deregister channels
                    if (i % MAX_SELECTABLE_FDS != 0) { // skip wakeupEvent
                        deregister(channelArray[i]);
                        SelectableChannel selch = channelArray[i].channel();
                        if (!selch.isOpen() && !selch.isRegistered())
                            ((SelChImpl)selch).kill();
                    }
                }
                //释放数据
                pollWrapper.free();
                pollWrapper = null;
                selectedKeys = null;
                channelArray = null;
                //释放辅助线程
                for (SelectThread t: threads)
                        t.makeZombie();
                //唤醒辅助线程使其退出。
                startLock.startThreads();
            }
        }
    }
}
```

## 总结

本文对`WindowsSelectorImpl`的代码实现进行详细解析。下一篇将对Linux下的`EpollSelectorImpl`的实现继续讲解。