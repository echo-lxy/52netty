# Selector 源码分析

## 什么是Selector

在网络传输时，客户端不定时的会与服务端进行连接，而在高并发场景中，大多数连接实际上是空闲的。因此为了提高网络传输高并发的性能，就出现各种I/O模型从而优化CPU处理效率。不同选择器实现了不同的I/O模型算法。同步I/O在linux上有EPoll模型，mac上有KQueue模型，windows上则为select模型。

> 关于I/O模型相关知识可以查看[《高性能网络通讯原理》](https://www.cnblogs.com/Jack-Blog/p/11923838.html)。

为了能知道哪些连接已就绪，在一开始我们需要定时轮询Socket是否有接收到新的连接，同时我们还要监控是否接收到已建立连接的数据，由于大多数情况下大多数网络连接实际是空闲的，因此每次都遍历所有的客户端，那么随着并发量的增加，性能开销也是呈线性增长。

有了`Selector`，我们可以让它帮我们做"监控"的动作，而当它监控到连接接收到数据时，我们只要去将数据读取出来即可,这样就大大提高了性能。要`Selector`帮我们做“监控”动作，那么我们需要告知它需要监控哪些`Channel`。

> 注意，只有网络通讯的时候才需要通过`Selector`监控通道。从代码而言，`Channel`必须继承`AbstractSelectableChannel`。

### 创建Selector

首先我们需要通过静态方法`Selector.open()`从创建一个`Selector`。

```java
Selector selector = Selector.open();
```

需要注意的是，Channel必须是非阻塞的，我们需要手动将Channel设置为非阻塞。调用`Channel`的实例方法`SelectableChannel.configureBlocking(boolean block)`。

### 注册通道

需要告诉Selector监控哪些`Channel`，通过`channel.register`将需要监控的通道注册到`Selector`中

注册是在`AbstractSelectableChannel`中实现的，当新的通道向`Selector`注册时会创建一个`SelectionKey`，并将其保存到`SelectionKey[] keys`缓存中。

```java
 
public final SelectionKey register(Selector sel, int ops, Object att) throws ClosedChannelException
{
    synchronized (regLock) {
        if (!isOpen())
            throw new ClosedChannelException();
            //当前Channel是否支持操作
        if ((ops & ~validOps()) != 0)
            throw new IllegalArgumentException();
            //阻塞不支持
        if (blocking)
            throw new IllegalBlockingModeException();
        SelectionKey k = findKey(sel);
        if (k != null) {
            //已经存在，则将其注册支持的操作
            k.interestOps(ops);
            //保存参数
            k.attach(att);
        }
        if (k == null) {
            // New registration
            synchronized (keyLock) {
                if (!isOpen())
                    throw new ClosedChannelException();
                //注册
                k = ((AbstractSelector)sel).register(this, ops, att);
                //添加到缓存
                addKey(k);
            }
        }
        return k;
    }
}
 
```

新的SelectionKey会调用到`AbstractSelector.register`,首先会先创建一个SelectionKeyImpl，然后调用方法`implRegister`执行实际注册，该功能是在各个平台的`SelectorImpl`的实现类中做具体实现。

```java
k = ((AbstractSelector)sel).register(this, ops, att);
protected final SelectionKey register(AbstractSelectableChannel ch, int ops, Object attachment)
{
    if (!(ch instanceof SelChImpl))
        throw new IllegalSelectorException();
        //创建SelectionKey
    SelectionKeyImpl k = new SelectionKeyImpl((SelChImpl)ch, this);
    k.attach(attachment);
    synchronized (publicKeys) {
        //注册
        implRegister(k);
    }
    //设置事件
    k.interestOps(ops);
    return k;
}
```

创建了`SelectionKey`后就将他加入到keys的缓存中，当keys缓存不足时，扩容两倍大小。

```java
private void addKey(SelectionKey k) {
    assert Thread.holdsLock(keyLock);
    int i = 0;
    if ((keys != null) && (keyCount < keys.length)) {
        // Find empty element of key array
        for (i = 0; i < keys.length; i++)
            if (keys[i] == null)
                break;
    } else if (keys == null) {
        keys =  new SelectionKey[3];
    } else {
        // 扩容两倍大小
        int n = keys.length * 2;
        SelectionKey[] ks =  new SelectionKey[n];
        for (i = 0; i < keys.length; i++)
            ks[i] = keys[i];
        keys = ks;
        i = keyCount;
    }
    keys[i] = k;
    keyCount++;
}
 
```

### SelectorProvider

在讨论Selector如何工作之前，我们先看一下Selector是如何创建的。我们通过`Selector.open()`静态方法创建了一个`Selector`。内部实际是通过`SelectorProvider.openSelector()`方法创建`Selector`。

```java
public static Selector open() throws IOException {
    return SelectorProvider.provider().openSelector();
}
```

#### 创建SelectorProvider

通过`SelectorProvider.provider()`静态方法，获取到`SelectorProvider`，首次获取时会通过配置等方式注入，若没有配置，则使用`DefaultSelectorProvider`生成。

```java
public static SelectorProvider provider() {
    synchronized (lock) {
        if (provider != null)
            return provider;
        return AccessController.doPrivileged(
            new PrivilegedAction<SelectorProvider>() {
                public SelectorProvider run() {
                        //通过配置的java.nio.channels.spi.SelectorProvider值注入自定义的SelectorProvider
                        if (loadProviderFromProperty())
                            return provider;
                        //通过ServiceLoad注入，然后获取配置的第一个服务
                        if (loadProviderAsService())
                            return provider;
                        provider = sun.nio.ch.DefaultSelectorProvider.create();
                        return provider;
                    }
                });
    }
}
```

若我们没有做特殊配置，则会使用默认的`DefaultSelectorProvider`创建`SelectorProvider`。
不同平台的`DefaultSelectorProvider`实现不一样。可以在`jdk\src\[macosx|windows|solaris]\classes\sun\nio\ch`找到实现`DefaultSelectorProvider.java`。下面是`SelectorProvider`的实现。

```java
//windows
public class DefaultSelectorProvider {
    private DefaultSelectorProvider() { }
    public static SelectorProvider create() {
        return new sun.nio.ch.WindowsSelectorProvider();
    }
}
//linux
public class DefaultSelectorProvider {
 
    private DefaultSelectorProvider() { }
 
    @SuppressWarnings("unchecked")
    private static SelectorProvider createProvider(String cn) {
        Class<SelectorProvider> c;
        try {
            c = (Class<SelectorProvider>)Class.forName(cn);
        } catch (ClassNotFoundException x) {
            throw new AssertionError(x);
        }
        try {
            return c.newInstance();
        } catch (IllegalAccessException | InstantiationException x) {
            throw new AssertionError(x);
        }
    }
 
    public static SelectorProvider create() {
        String osname = AccessController
            .doPrivileged(new GetPropertyAction("os.name"));
        if (osname.equals("SunOS"))
            return createProvider("sun.nio.ch.DevPollSelectorProvider");
        if (osname.equals("Linux"))
            return createProvider("sun.nio.ch.EPollSelectorProvider");
        return new sun.nio.ch.PollSelectorProvider();
    }
 
}
```

#### 创建Selector

获取到`SelectorProvider`后，创建`Selector`了。通过`SelectorProvider.openSelector()`实例方法创建一个`Selector`

```java
//windows
public class WindowsSelectorProvider extends SelectorProviderImpl {
 
    public AbstractSelector openSelector() throws IOException {
        return new WindowsSelectorImpl(this);
    }
}
//linux
public class EPollSelectorProvider
    extends SelectorProviderImpl
{
    public AbstractSelector openSelector() throws IOException {
        return new EPollSelectorImpl(this);
    }
    ...
}
```

windows下创建了`WindowsSelectorImpl`,linux下创建了`EPollSelectorImpl`。

所有的`XXXSelectorImpl`都继承自`SelectorImpl`，可以在`jdk\src\[macosx|windows|solaris|share]\classes\sun\nio\ch`找到实现`XXXSelectorImpl.java`。继承关系如下图所示。
![20200102205431.png](https://img2018.cnblogs.com/blog/580757/202001/580757-20200102205432942-2035046906.png)

接下里我们讨论一下Selector提供的主要功能，后面在分析Windows和Linux下`Selector`的具体实现。

### SelectorImpl

在创建`SelectorImpl`首先会初始化2个HashSet，`publicKeys`存放用于一个存放所有注册的SelectionKey，`selectedKeys`用于存放已就绪的SelectionKey。

```java
protected SelectorImpl(SelectorProvider sp) {
    super(sp);
    keys = new HashSet<SelectionKey>();
    selectedKeys = new HashSet<SelectionKey>();
    if (Util.atBugLevel("1.4")) {
        publicKeys = keys;
        publicSelectedKeys = selectedKeys;
    } else {
        //创建一个不可修改的集合
        publicKeys = Collections.unmodifiableSet(keys);
        //创建一个只能删除不能添加的集合
        publicSelectedKeys = Util.ungrowableSet(selectedKeys);
    }
}
```

> 关于`Util.atBugLevel`找到[一篇文章](https://www.iteye.com/blog/donald-draper-2370519)有提到该方法。似乎是和[EPoll的一个空指针异常](https://docs.oracle.com/cd/E19226-01/820-7688/6niu9p8i3/index.html)相关。这个bug在nio bugLevel=1.4版本引入，这个bug在jdk1.5中存在，直到jdk1.7才修复。

前面我们已经向`Selector`注册了通道，现在我们需要调用`Selector.select()`实例方法从系统内存中加载已就绪的文件描述符。

```java
 
public int select() throws IOException {
    return select(0);
}
public int select(long timeout)
    throws IOException
{
    if (timeout < 0)
        throw new IllegalArgumentException("Negative timeout");
    return lockAndDoSelect((timeout == 0) ? -1 : timeout);
}
 
private int lockAndDoSelect(long timeout) throws IOException {
    synchronized (this) {
        if (!isOpen())
            throw new ClosedSelectorException();
        synchronized (publicKeys) {
            synchronized (publicSelectedKeys) {
                return doSelect(timeout);
            }
        }
    }
}
protected abstract int doSelect(long timeout) throws IOException;
```

最终会调用具体`SelectorImpl`的`doSelect`,具体内部主要执行2件事

1. 调用native方法获取已就绪的文件描述符。
2. 调用`updateSelectedKeys`更新已就绪事件的`SelectorKey`

当获取到已就绪的`SelectionKey`后，我们就可以遍历他们。根据`SelectionKey`的事件类型决定需要执行的具体逻辑。

```java
//获取到已就绪的Key进行遍历
Set<SelectionKey> selectKeys = selector.selectedKeys();
Iterator<SelectionKey> it = selectKeys.iterator();
while (it.hasNext()) {
    SelectionKey key = it.next();
    //处理事件。
    if(key.isAcceptable()){
        doAccept(key);
    }
    else if(key.isReadable())
    {
        doRead(key);
    }
    ...
    it.remove();
}
```

## 总结

本文对`Selector`、`SelectorProvider`的创建进行分析，总的流程可以参考下图

![img](https://blog-pictures.oss-cn-shanghai.aliyuncs.com/Selector.open.png)

对于后面步骤的`EpollArrayWarpper()`会在`SelectorImpl`个平台具体实现进行讲解。后面会分2对`WindowsSelectorImpl`和`EpollSelectorImpl`进行分析。