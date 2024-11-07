# EPollSelectorIpml 源码分析

## 前言

本来是想学习Netty的，但是Netty是一个NIO框架，因此在学习netty之前，还是先梳理一下NIO的知识。通过剖析[源码](http://jdk.java.net/)理解NIO的设计原理。

> 本系列文章针对的是JDK1.8.0.161的源码。

[NIO-Selector源码分析](https://www.cnblogs.com/Jack-Blog/p/12367953.html)对`Selector`的功能和创建过程进行了分析，本篇对Linux环境下JDK实现的`EPollSelectorImpl`源码进行详细讲解。

本篇文章不会对EPoll算法进行详细介绍，对epoll算法感兴趣或还不了解的同学可以看[epoll原理详解及epoll反应堆模型](https://blog.csdn.net/daaikuaichuan/article/details/83862311)先进行学习。

在详细介绍`EpollSelectorProvider`之前我们先了解一下EPoll主要的三个步骤：

1. 调用`epoll_create`建立一个epoll 对象(在epoll文件系统中给这个句柄分配资源)；
2. 调用`epoll_ctl`向epoll对象中添加或删除文件句柄及监控事件。
3. 调用`epoll_wait`收集发生事件的文件描述符。

## 初始化EPollSelectorProvider

[NIO-Selector源码分析](https://www.cnblogs.com/Jack-Blog/p/12367953.html)提到，若没有进行配置时，默认通过`sun.nio.ch.DefaultSelectorProvider.create()`创建`SelectorProvider`。Linux下的代码路径在`jdk\src\solaris\classes\sun\nio\ch\DefaultSelectorProvider.java`。在其内部通过实际是创建了一个`EPollSelectorProvider`。

## 创建EPollSelectorImpl

`EPollSelectorProvider`是用于创建`EPollSelectorImpl`的。

```java
Selector.Open()->
SelectorProvider.provider()->
sun.nio.ch.DefaultSelectorProvider.create()->
EPollSelectorProvider.openSelector()->
new EPollSelectorImpl(this)
public class EPollSelectorProvider extends SelectorProviderImpl
{
    public AbstractSelector openSelector() throws IOException {
        return new EPollSelectorImpl(this);
    }
 
    public Channel inheritedChannel() throws IOException {
        return InheritedChannel.getChannel();
    }
}
```

> `inheritedChannel()`可以返回系统默认SelectorProvider创建的通道，主要有些操作系统底层需要调用默认的通道。

## EPollSelectorImpl结构

在详细讲解`EPollSelectorImpl`源码之前，先了解`EPollSelectorImpl`的主要的数据结构和属性。

| 名称                                  | 作用                                         |
| ------------------------------------- | -------------------------------------------- |
| Map<Integer,SelectionKeyImpl> fdToKey | 保存文件描述符句柄和的SelectionKey的映射关系 |
| int fd0                               | 管道的读端文件描述符                         |
| int fd1                               | 管道的写端文件描述符                         |
| EPollArrayWrapper pollWrapper         | 调用底层Epoll算法的包装类                    |

```java
 
 EPollSelectorImpl(SelectorProvider sp) throws IOException {
    super(sp);
    long pipeFds = IOUtil.makePipe(false);
    fd0 = (int) (pipeFds >>> 32); //无符号移位
    fd1 = (int) pipeFds;
    pollWrapper = new EPollArrayWrapper();
    pollWrapper.initInterrupt(fd0, fd1);
    fdToKey = new HashMap<>();
}
void initInterrupt(int fd0, int fd1) {
    outgoingInterruptFD = fd1;
    incomingInterruptFD = fd0;
    //将管道的读取端注册
    epollCtl(epfd, EPOLL_CTL_ADD, fd0, EPOLLIN);
}
```

> pipeFds高32位存放的是通道read端的文件描述符FD，低32位存放的是write端的文件描述符。这里做移位处理。

通过调用JNI的`makePipe`方法创建单向管道。

```java
JNIEXPORT jlong JNICALL
Java_sun_nio_ch_IOUtil_makePipe(JNIEnv *env, jobject this, jboolean blocking)
{
    int fd[2];
 
    if (pipe(fd) < 0) {
        JNU_ThrowIOExceptionWithLastError(env, "Pipe failed");
        return 0;
    }
    if (blocking == JNI_FALSE) {
        //配置阻塞
        if ((configureBlocking(fd[0], JNI_FALSE) < 0)
            || (configureBlocking(fd[1], JNI_FALSE) < 0)) {
            JNU_ThrowIOExceptionWithLastError(env, "Configure blocking failed");
            close(fd[0]);
            close(fd[1]);
            return 0;
        }
    }
    //高32位存读端，低32位存写端
    return ((jlong) fd[0] << 32) | (jlong) fd[1];
}
 
```

JNI内部则通过`pipe`创建管道。

> 对于管道的详细逻辑可以看[《Linux管道 - 系统调用pipe()函数实现》](https://blog.csdn.net/m0_37925202/article/details/79835102)

### fdToKey

在注册时会将文件描述符的句柄和对应的SelectionKey保存到`Map<Integer,SelectionKeyImpl> fdToKey`中

### 管道文件描述符

在EPollSelectorImpl创建的时候会使用`IOUtil.makePipe(false)`调用创建一个管道，用于唤醒线程用。当线程中断时通过向写管道写入一个字节来唤醒线程，具体可以看[doSelect](https://www.cnblogs.com/Jack-Blog/p/12394487.html#doselect)逻辑。

### EPollArrayWrapper

`PollArrayWrapper`用于存放linux的`epoll_event`结构。

```c++
 typedef union epoll_data {
     void *ptr;
     int fd;
     __uint32_t u32;
     __uint64_t u64;
  } epoll_data_t;
 
 struct epoll_event {
     __uint32_t events;
     epoll_data_t data;
 };
```

#### 创建EPoll文件描述符

在`EPollArrayWrapper`创建时候会创建epoll文件描述符和epoll_event数组结构

```java
EPollArrayWrapper() throws IOException {
    // creates the epoll file descriptor
    epfd = epollCreate();
 
    // the epoll_event array passed to epoll_wait
    int allocationSize = NUM_EPOLLEVENTS * SIZE_EPOLLEVENT;
    pollArray = new AllocatedNativeObject(allocationSize, true);
    pollArrayAddress = pollArray.address();
 
    // eventHigh needed when using file descriptors > 64k
    if (OPEN_MAX > MAX_UPDATE_ARRAY_SIZE)
        eventsHigh = new HashMap<>();
}
//最大不超过64K
private static final int MAX_UPDATE_ARRAY_SIZE = AccessController.doPrivileged(
        new GetIntegerAction("sun.nio.ch.maxUpdateArraySize", Math.min(OPEN_MAX, 64*1024)));
 
```

`EPollArrayWrapper`内部会为维护两个结构，当句柄值小于`MAX_UPDATE_ARRAY_SIZE`时会保存到数组结构中。否则会存储到Map中。主要是优化效率。

```java
private static final int MAX_UPDATE_ARRAY_SIZE = AccessController.doPrivileged(
        new GetIntegerAction("sun.nio.ch.maxUpdateArraySize", Math.min(OPEN_MAX, 64*1024)));
 
```

- 通过`epollCreate`方法创建epoll文件描述符,JNI调用底层的`epoll_create`方法。传入的参数位最大注册的socket fd数量。

```java
JNIEXPORT jint JNICALL
Java_sun_nio_ch_EPoll_epollCreate(JNIEnv *env, jclass c) {
    /*
     * epoll_create expects a size as a hint to the kernel about how to
     * dimension internal structures. We can't predict the size in advance.
     */
    int epfd = epoll_create(256);
    if (epfd < 0) {
       JNU_ThrowIOExceptionWithLastError(env, "epoll_create failed");
    }
    return epfd;
}
```

> epoll_create用于创建EPoll事件所需的内存空间，默认为256，在Linux 2.6.8以后，传入的size就没用了，底层会动态调整所需数据结构的大小。详情可以看下[epoll_create的方法描述](http://man7.org/linux/man-pages/man2/epoll_create.2.html)

#### 初始化epoll_event数组

epfd创建完后，创建epoll_event的数组，首先查询`epoll_event`结构的大小

```java
private static final int SIZE_EPOLLEVENT  = sizeofEPollEvent();
Java_sun_nio_ch_EPollArrayWrapper_sizeofEPollEvent(JNIEnv* env, jclass this)
{
    return sizeof(struct epoll_event);
}
```

查询配置的文件描述符最大数量

```java
private static final int OPEN_MAX         = IOUtil.fdLimit();
private static final int NUM_EPOLLEVENTS  = Math.min(OPEN_MAX, 8192);
Java_sun_nio_ch_IOUtil_fdLimit(JNIEnv *env, jclass this)
{
    struct rlimit rlp;
    if (getrlimit(RLIMIT_NOFILE, &rlp) < 0) {
        JNU_ThrowIOExceptionWithLastError(env, "getrlimit failed");
        return -1;
    }
    if (rlp.rlim_max < 0 || rlp.rlim_max > java_lang_Integer_MAX_VALUE) {
        return java_lang_Integer_MAX_VALUE;
    } else {
        return (jint)rlp.rlim_max;
    }
}
```

> `getrlimit`用于获取资源使用限制，`RLIMIT_NOFILE`获取最大文件打开数量。对于`getrlimit`详细介绍可以看一下[
> Linux系统调用--getrlimit()与setrlimit()函数详解
> ](https://www.cnblogs.com/niocai/archive/2012/04/01/2428128.html)

根据查询到的`epoll_event`结构大小和数量初始化数组大小。

```java
int allocationSize = NUM_EPOLLEVENTS * SIZE_EPOLLEVENT;
pollArray = new AllocatedNativeObject(allocationSize, true);
```

在 `EPollArrayWrapper` 内部使用 `AllocatedNativeObject`对象创建的堆外(native)内存对象。
将数组的首地址保存到`pollArrayAddress`中，**在调用`epollWait`的时候需要传递该参数给JNI**。

和Windows的`PollArrayWrapper`一样，`EPollArrayWrapper`也暴露了读写FD和Event的方法供`EPollSelectorImpl`使用。

```java
void putEventOps(int i, int event) {
    int offset = SIZE_EPOLLEVENT * i + EVENT_OFFSET;
    pollArray.putInt(offset, event);
}
 
void putDescriptor(int i, int fd) {
    int offset = SIZE_EPOLLEVENT * i + FD_OFFSET;
    pollArray.putInt(offset, fd);
}
 
int getEventOps(int i) {
    int offset = SIZE_EPOLLEVENT * i + EVENT_OFFSET;
    return pollArray.getInt(offset);
}
 
int getDescriptor(int i) {
    int offset = SIZE_EPOLLEVENT * i + FD_OFFSET;
    return pollArray.getInt(offset);
}
```

## 注册

```java
protected void implRegister(SelectionKeyImpl ski) {
    if (closed)
        throw new ClosedSelectorException();
    SelChImpl ch = ski.channel;
    //获取通道的句柄
    int fd = Integer.valueOf(ch.getFDVal());
    //加入到缓存中
    fdToKey.put(fd, ski);
    //加入到数组缓存
    pollWrapper.add(fd);
    keys.add(ski);
}
```

- 在注册的时候会将`SelectionKey`加入到`fdToKey`和`keys`，同时会将文件描述符加入到`pollWrapper`

```java
pollWrapper.add(fd);
void add(int fd) {
    // force the initial update events to 0 as it may be KILLED by a
    // previous registration.
    synchronized (updateLock) {
        assert !registered.get(fd);
        //初始化事件掩码为0
        setUpdateEvents(fd, (byte)0, true);
    }
}
private void setUpdateEvents(int fd, byte events, boolean force) {
    //小于MAX_UPDATE_ARRAY_SIZE存到数组中
    if (fd < MAX_UPDATE_ARRAY_SIZE) {
        if ((eventsLow[fd] != KILLED) || force) {
            eventsLow[fd] = events;
        }
    } else {
        //大于MAX_UPDATE_ARRAY_SIZE存到map中
        Integer key = Integer.valueOf(fd);
        if (!isEventsHighKilled(key) || force) {
            eventsHigh.put(key, Byte.valueOf(events));
        }
    }
}
private boolean isEventsHighKilled(Integer key) {
    assert key >= MAX_UPDATE_ARRAY_SIZE;
    Byte value = eventsHigh.get(key);
    return (value != null && value == KILLED);
}
 
```

若文件描述符的值为`KILLED`(-1)时，该管道被释放。不再加入。如上面所述，这里会根据key的大小存放到map`eventsHigh`或字节数组`eventsLow`中。

在调用`poll`的时候才会调用`epollCtl`进行注册。

```java
int poll(long timeout) throws IOException {
    //更新epoll事件，实际调用`epollCtl`加入到epollfd中
    updateRegistrations();
    ...
}
private void updateRegistrations() {
    synchronized (updateLock) {
        int j = 0;
        while (j < updateCount) {
            int fd = updateDescriptors[j];
            short events = getUpdateEvents(fd);
            boolean isRegistered = registered.get(fd);
            int opcode = 0;
 
            if (events != KILLED) {
                //已经注册过
                if (isRegistered) {
                    //修改或删除
                    opcode = (events != 0) ? EPOLL_CTL_MOD : EPOLL_CTL_DEL;
                } else {
                    //新增
                    opcode = (events != 0) ? EPOLL_CTL_ADD : 0;
                }
                if (opcode != 0) {
                    epollCtl(epfd, opcode, fd, events);
                    if (opcode == EPOLL_CTL_ADD) {
                        //增加到registered缓存是否已注册
                        registered.set(fd);
                    } else if (opcode == EPOLL_CTL_DEL) {
                        registered.clear(fd);
                    }
                }
            }
            j++;
        }
        updateCount = 0;
    }
}
private byte getUpdateEvents(int fd) {
    if (fd < MAX_UPDATE_ARRAY_SIZE) {
        return eventsLow[fd];
    } else {
        Byte result = eventsHigh.get(Integer.valueOf(fd));
        // result should never be null
        return result.byteValue();
    }
}
```

## doSelect

```java
 
protected int doSelect(long timeout) throws IOException {
    if (closed)
        throw new ClosedSelectorException();
    //1. 删除取消的key
    processDeregisterQueue();
    try {
        begin();
        //2. 获取就绪文件描述符
        pollWrapper.poll(timeout);
    } finally {
        end();
    }
    //3. 再次删除取消的key
    processDeregisterQueue();
    //4. 将就绪的key加入到selectedKeys中
    int numKeysUpdated = updateSelectedKeys();
    //5. 若管道被唤醒清理唤醒的数据
    if (pollWrapper.interrupted()) {
        // Clear the wakeup pipe
        pollWrapper.putEventOps(pollWrapper.interruptedIndex(), 0);
        synchronized (interruptLock) {
            pollWrapper.clearInterrupted();
            IOUtil.drain(fd0);
            interruptTriggered = false;
        }
    }
    return numKeysUpdated;
}
```

- 删除取消的key,当channel关闭时，对应的Key会被取消,被取消的key会加入到`cancelledKeys`中。调用processDeregisterQueue遍历所有的key进行卸载。

```java
 
processDeregisterQueue();
//遍历所有已取消的key，取消他们
void processDeregisterQueue() throws IOException {
    // Precondition: Synchronized on this, keys, and selectedKeys
    Set<SelectionKey> cks = cancelledKeys();
    //遍历每个key调用卸载
    implDereg(ski);
}
protected void implDereg(SelectionKeyImpl ski) throws IOException {
    assert (ski.getIndex() >= 0);
    SelChImpl ch = ski.channel;
    int fd = ch.getFDVal();
    //根据文件句柄值移除
    fdToKey.remove(Integer.valueOf(fd));
    //从堆外内存溢出epoll_event结构
    pollWrapper.remove(fd);
    ski.setIndex(-1);
    keys.remove(ski);
    selectedKeys.remove(ski);
    //将key设置为无效
    deregister((AbstractSelectionKey)ski);
    SelectableChannel selch = ski.channel();
    if (!selch.isOpen() && !selch.isRegistered())
        ((SelChImpl)selch).kill();
} 
```

从`pollWrapper`移除，会将句柄值设置为`KILLED`(-1)

```java
pollWrapper.remove(fd);
void remove(int fd) {
        synchronized (updateLock) {
            //设置实现值为-1 取消
            setUpdateEvents(fd, KILLED, false);
            // remove from epoll
            if (registered.get(fd)) {
                //从epool对象中删除
                epollCtl(epfd, EPOLL_CTL_DEL, fd, 0);
                registered.clear(fd);
            }
        }
    }
```

> EPOLL_CTL_DEL操作符将文件描述符从epoll fd中移除。

- 获取就绪文件描述符

通过调用`epollWait`方法，获取到已就绪的文件描述符，存放在`pollArrayAddress`地址中。

```java
pollWrapper.poll(timeout);
int poll(long timeout) throws IOException {
    //更新epoll事件，实际调用`epollCtl`加入到epollfd中
    updateRegistrations();
    //获取已就绪的文件句柄
    updated = epollWait(pollArrayAddress, NUM_EPOLLEVENTS, timeout, epfd);
    //如是唤醒文件句柄，则跳过，设置interrupted=true
    for (int i=0; i<updated; i++) {
        if (getDescriptor(i) == incomingInterruptFD) {
            interruptedIndex = i;
            interrupted = true;
            break;
        }
    }
    return updated;
}
```

- 再次尝试删除取消的key。`epollWait`阻塞的时候可能会有channel被关闭，因此需要再次调用删除取消key。
- 将就绪的key加入到selectedKeys中

```java
private int updateSelectedKeys() {
        int entries = pollWrapper.updated;
        int numKeysUpdated = 0;
        for (int i=0; i<entries; i++) {
            int nextFD = pollWrapper.getDescriptor(i);
            SelectionKeyImpl ski = fdToKey.get(Integer.valueOf(nextFD));
            // ski is null in the case of an interrupt
            if (ski != null) {
                int rOps = pollWrapper.getEventOps(i);
                if (selectedKeys.contains(ski)) {
                    if (ski.channel.translateAndSetReadyOps(rOps, ski)) {
                        numKeysUpdated++;
                    }
                } else {
                    ski.channel.translateAndSetReadyOps(rOps, ski);
                    if ((ski.nioReadyOps() & ski.nioInterestOps()) != 0) {
                        //加入到selectedKeys中
                        selectedKeys.add(ski);
                        numKeysUpdated++;
                    }
                }
            }
        }
        return numKeysUpdated;
    }
```

- 当`epollWait`是被管道唤醒时，则将管道数据都读取出来以清除管道数据

> EPoll有水平唤醒触发和边缘触发两种触发模式，水平触发有数据可读，若不读取完，下次调用poll时会一致被唤醒。而边缘触发则触发一次后不处理，下次除非有新的事件到来否则不会再唤醒。边缘触发性能更好。这里必须将管道数据全部读取完才行，避免设置为水平触发时管道一值唤醒。

当线程中断时， 会调用`wakeup`唤醒，向管道中写入一个字节数据使其读事件就绪被唤醒。在前面的文章提到过[线程中断接口](https://www.cnblogs.com/Jack-Blog/p/12040082.html#udp协议)。

```java
public Selector wakeup() {
    synchronized (interruptLock) {
        if (!interruptTriggered) {
            pollWrapper.interrupt();
            interruptTriggered = true;
        }
    }
    return this;
}
JNIEXPORT void JNICALL
Java_sun_nio_ch_EPollArrayWrapper_interrupt(JNIEnv *env, jobject this, jint fd)
{
    int fakebuf[1];
    fakebuf[0] = 1;
    if (write(fd, fakebuf, 1) < 0) {
        JNU_ThrowIOExceptionWithLastError(env,"write to interrupt fd failed");
    }
}
```

清理唤醒管道数据，将数据读出来。

```java
IOUtil.drain(fd0);
JNIEXPORT jboolean JNICALL
Java_sun_nio_ch_IOUtil_drain(JNIEnv *env, jclass cl, jint fd)
{
    char buf[128];
    int tn = 0;
 
    for (;;) {
        int n = read(fd, buf, sizeof(buf));
        tn += n;
        if ((n < 0) && (errno != EAGAIN))
            JNU_ThrowIOExceptionWithLastError(env, "Drain");
        if (n == (int)sizeof(buf))
            continue;
        return (tn > 0) ? JNI_TRUE : JNI_FALSE;
    }
}
 
```

## 关闭EpollSelectorImpl

关闭EpollSelectorImpl时会将所有注册的通道一同关闭

```java
 
    protected void implClose() throws IOException {
        if (closed)
            return;
        closed = true;
 
        // prevent further wakeup
        synchronized (interruptLock) {
            interruptTriggered = true;
        }
        //关闭管道文件描述符
        FileDispatcherImpl.closeIntFD(fd0);
        FileDispatcherImpl.closeIntFD(fd1);
        //关闭epoll fd，并释放堆外内存。
        pollWrapper.closeEPollFD();
        // it is possible
        selectedKeys = null;
 
        // 情理所有通道
        Iterator<SelectionKey> i = keys.iterator();
        while (i.hasNext()) {
            SelectionKeyImpl ski = (SelectionKeyImpl)i.next();
            SelectableChannel selch = ski.channel();
            if (!selch.isOpen() && !selch.isRegistered())
                ((SelChImpl)selch).kill();
            i.remove();
        }
 
        fd0 = -1;
        fd1 = -1;
    }
pollWrapper.closeEPollFD();
void closeEPollFD() throws IOException {
    //关闭epfd
    FileDispatcherImpl.closeIntFD(epfd);
    //释放堆外内存
    pollArray.free();
}
```

## 总结

本文对`EPollSelectorImpl`的代码实现进行详细解析。相比`WindowsSelectorImpl`的select模型而言，因为没有最大文件描述符的限制，因此也无需调用poll多次。通过简单的调用JNI方法轻易的实现了高性能的I/O模型。

至此，本系列NIO源码分析章节已经结束。通过9篇文章对NIO的各个块的源码进行分析，为后续对Netty的源码分析打下基础。