# ChannelHandler 接口

## 介绍

> 处理器`ChannelHandler` 就是用来处理`I/O`事件或拦截`I/O`操作，并将其转发到所属管道 `ChannelPipeline`中的下一个处理器`ChannelHandler`。

### 子类型

`ChannelHandler`本身并没有提供很多方法，但是你通常必须实现它的一个子类型:

1. `ChannelInboundHandler`处理入站`I/O`事件。
2. `ChannelOutboundHandler`处理出站`I/O`操作。

另外，为了方便使用，还提供了以下适配器类:

1. `ChannelInboundHandlerAdapter`处理入站`I/O`事件。
2. `ChannelOutboundHandlerAdapter`用于处理出站`I/O`操作。
3. `ChannelDuplexHandler`处理入站和出站事件。

### 上下文对象

将`ChannelHandler` 添加到管道时，会创建这个`ChannelHandler`的上下文对象添加到管道中。

> - `ChannelHandler`通过上下文对象与它所属的`ChannelPipeline`进行交互。
> - 使用上下文对象，`ChannelHandler`可以向上游或下游传递事件，动态修改管道，或者存储特定于该处理器的信息(使用`AttributeKeys`)。

上下文对象 即为 ChannelHandlerContext

### 状态管理

`ChannelHandler`经常需要存储一些状态信息，有两种方式:

1. 最简单和推荐的方法是直接使用成员变量， 例如:

   ```java
    public interface Message {
       // your methods here
   }
   
   public class DataServerHandler extends SimpleChannelInboundHandler<Message> {
   
       private boolean loggedIn;
   
        @Override
       public void channelRead0(ChannelHandlerContext ctx, Message message) {
           if (message instanceof LoginMessage) {
               authenticate((LoginMessage) message);
               loggedIn = true;
           } else (message instanceof GetDataMessage) {
               if (loggedIn) {
                   ctx.writeAndFlush(fetchSecret((GetDataMessage) message));
               } else {
                   fail();
               }
           }
       }
       ...
   }
   ```

   > - 直接使用`ChannelHandler`成员变量`loggedIn` 来记录当前的登录状态。
   > - 因为使用`ChannelHandler`成员变量保存状态，所以这个处理器在每个管道`ChannelPipeline`(也是每个通道`Channel`)中都是新的处理程序实例，不能和别的通道共享同一个`ChannelHandler`实例。

   

   ```java
    // Create a new handler instance per channel.
   // See ChannelInitializer.initChannel(Channel).
   public class DataServerInitializer extends ChannelInitializer<Channel> {
        @Override
       public void initChannel(Channel channel) {
           channel.pipeline().addLast("handler", new DataServerHandler());
       }
   }
   ```

2. 使用 

   ```Java
   AttributeKeys
   ```

   > - 尽管建议使用成员变量来存储处理程序的状态，但出于某些原因，您可能不想创建许多处理程序实例。
   > - 在这种情况下，你可以使用上下文 `ChannelHandlerContext`提供的`AttributeKeys` 存储信息:

   ```java
   public interface Message {
      // your methods here
   }
   
   @Sharable
   public class DataServerHandler extends SimpleChannelInboundHandler<Message> {
      private final AttributeKey<Boolean> auth =
            AttributeKey.valueOf("auth");
   
       @Override
      public void channelRead(ChannelHandlerContext ctx, Message message) {
          Attribute<Boolean> attr = ctx.attr(auth);
          if (message instanceof LoginMessage) {
              authenticate((LoginMessage) o);
              attr.set(true);
          } else (message instanceof GetDataMessage) {
              if (Boolean.TRUE.equals(attr.get())) {
                  ctx.writeAndFlush(fetchSecret((GetDataMessage) o));
              } else {
                  fail();
              }
          }
      }
      ...
   }
   public class DataServerInitializer extends ChannelInitializer<Channel> {
   
      private static final DataServerHandler SHARED = new DataServerHandler();
   
       @Override
      public void initChannel(Channel channel) {
          channel.pipeline().addLast("handler", SHARED);
      }
   }
   ```

   > - 注意这里的`ChannelHandler` 子类必须使用 `@Sharable` 注解修饰，否则会抛出异常。
   > - 如果你想只创建一次该`ChannelHandler`的实例，并将其多次添加到一个或多个`ChannelPipeline`中，必须使用 `@Sharable` 注解修饰。

## 源码

```dart
public interface ChannelHandler {

    /**
     * 在该ChannelHandler 对应上下文 ChannelHandlerContext 对象
     * 添加到管道 ChannelPipeline 后回调这个方法，
     * 并将上下文 ChannelHandlerContext 传递过来，表示它已准备好处理事件。
     */
    void handlerAdded(ChannelHandlerContext ctx) throws Exception;

    /**
     * 当该ChannelHandler 对应上下文 ChannelHandlerContext 对象
     * 从管道 ChannelPipeline 中删除后回调这个方法，
     * 表示它已准备好处理事件。
     */
    void handlerRemoved(ChannelHandlerContext ctx) throws Exception;

    /**
     * Gets called if a {@link Throwable} was thrown.
     * 有异常 Throwable 抛出后调用这个方法。
     *
     * @deprecated 已被废弃，如果你想处理此类事件，应该实现
     *             ChannelInboundHandler 里面的 exceptionCaught(ChannelHandlerContext, Throwable) 方法。
     */
    @Deprecated
    void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) throws Exception;

    /**
     * 被注解 @Sharable 标志的ChannelHandler 的同一个实例，
     * 可以多次添加到一个或多个管道 ChannelPipeline。
     * 而不使用注解 @Sharable 的ChannelHandler实例
     * 只能添加到一个管道 `ChannelPipeline` 中，而且管道中也必须是唯一的。
     */
    @Inherited
    @Documented
    @Target(ElementType.TYPE)
    @Retention(RetentionPolicy.RUNTIME)
    @interface Sharable {
        // no value
    }
}
```

> `ChannelHandler` 接口本身非常简单:
>
> - `handlerAdded(ChannelHandlerContext ctx)`: 当其上下文对象添加到管道后，回调这个方法。
> - `handlerRemoved(ChannelHandlerContext ctx)`: 当其上下文对象从管道中删除后，回调这个方法。
> - `exceptionCaught(...)`: 事件处理中抛出异常时，回调这个方法。已被废弃，建议使用子接口 `ChannelInboundHandler` 的 `exceptionCaught(...)` 方法。
> - `@interface Sharable`： 只有被`@Sharable` 注解的`ChannelHandler` 同一个实例可以多次添加到一个或多个管道 `ChannelPipeline`。

# ChannelInboundHandler 和 ChannelInboundInvoker

这两个接口相关联：

1. `ChannelInboundHandler` 用来处理入站`I/O`事件。

2. `ChannelInboundInvoker`用来传递入站I/O事件。

   > - `ChannelInboundInvoker` 的子接口管道 `ChannelPipeline` , 通过`ChannelInboundInvoker` 的方法，在整个入站处理器 `ChannelInboundHandler` 链表传递入站`I/O`事件。
   > - `ChannelInboundInvoker` 的子接口上下文 `ChannelHandlerContext` , 通过`ChannelInboundInvoker` 的方法，向 `ChannelInboundHandler` 链表下游传递入站`I/O`事件。

## ChannelInboundHandler 接口

```java
/**
 * 用于处理 入站操作的 ChannelHandler
 */
public interface ChannelInboundHandler extends ChannelHandler {

    /**
     * ChannelHandlerContext拥有的通道Channel已经注册到它的EventLoop中
     */
    void channelRegistered(ChannelHandlerContext ctx) throws Exception;

    /**
     * ChannelHandlerContext 拥有的通道Channel 从其EventLoop注销
     */
    void channelUnregistered(ChannelHandlerContext ctx) throws Exception;

    /**
     * The {@link Channel} of the {@link ChannelHandlerContext} is now active
     * ChannelHandlerContext 拥有的通道Channel 当前是活动的
     */
    void channelActive(ChannelHandlerContext ctx) throws Exception;

    /**
     * 已注册的ChannelHandlerContext 拥有的通道Channel 当前是不活动的，并已到达其生命周期的终点。
     */
    void channelInactive(ChannelHandlerContext ctx) throws Exception;

    /**
     * 当前通道Channel 从远端接收到消息时调用。
     */
    void channelRead(ChannelHandlerContext ctx, Object msg) throws Exception;

    /**
     * 当读操作读取的最后一条消息已被channelRead(ChannelHandlerContext, Object)消费后调用。
     *
     * 如果ChannelOption的配置项AUTO_READ是关闭的，
     * 那么在手动调用ChannelHandlerContext.read() 方法之前，将不再尝试从当前通道Channel读取入站数据。
     */
    void channelReadComplete(ChannelHandlerContext ctx) throws Exception;

    /**
     * 在触发用户事件时调用。
     */
    void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception;

    /**
     * 在通道Channel的可写状态发生改变后调用。
     * 可以使用 Channel.isWritable() 检查当前通道的是否可写。
     * 用来调控写缓冲区的。
     */
    void channelWritabilityChanged(ChannelHandlerContext ctx) throws Exception;

    /**
     * 在Throwable被抛出时调用。
     */
    @Override
    @SuppressWarnings("deprecation")
    void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) throws Exception;
}
```

一共就`9`个方法，分别是:

1. ```
   void channelRegistered(ChannelHandlerContext ctx)
   ```

   > 通道`Channel`注册到事件轮询器`EventLoop`中。

2. ```
   void channelUnregistered(ChannelHandlerContext ctx)
   ```

   > 通道`Channel` 从其`EventLoop`中注销

3. ```
   void channelActive(ChannelHandlerContext ctx)
   ```

   > 通道`Channel` 当前是活动的

4. ```
   void channelInactive(ChannelHandlerContext ctx)
   ```

   > 通道`Channel` 当前是不活动的，并已到达其生命周期的终点。

5. ```
   void channelRead(ChannelHandlerContext ctx, Object msg)
   ```

   > 当前通道`Channel`从远端接收到消息时调用。

6. `void channelReadComplete(ChannelHandlerContext ctx)`

> 当读操作读取的最后一条消息已被`channelRead(ChannelHandlerContext, Object)`消费后调用。

1. ```
   void userEventTriggered(ChannelHandlerContext ctx, Object evt)
   ```

   > 触发用户事件时调用。

2. ```
   void channelWritabilityChanged(ChannelHandlerContext ctx)
   ```

   > 在通道`Channel`的可写状态发生改变后调用。

3. ```
   void exceptionCaught(ChannelHandlerContext ctx, Throwable cause)
   ```

   > 抛出异常是调用。

## ChannelInboundInvoker 接口

```Java
public interface ChannelInboundInvoker {

    /**
     * 当通道 Channel 注册到事件轮询器 EventLoop时，有可能会调用这个方法。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 channelRegistered(ChannelHandlerContext) 方法。
     */
    ChannelInboundInvoker fireChannelRegistered();

    /**
     * 当通道 Channel 从已注册事件轮询器 EventLoop 取消注册时，有可能会调用这个方法。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 channelUnregistered(ChannelHandlerContext) 方法。
     */
    ChannelInboundInvoker fireChannelUnregistered();

    /**
     * A {@link Channel} is active now, which means it is connected.
     * 当通道 Channel 变成活跃，即已经连接成功后，有可能会调用这个方法。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 channelActive(ChannelHandlerContext) 方法。
     */
    ChannelInboundInvoker fireChannelActive();

    /**
     * A {@link Channel} is inactive now, which means it is closed.
     * 当通道 Channel 变成不活跃，即通道已关闭时，有可能会调用这个方法。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 channelInactive(ChannelHandlerContext) 方法。
     */
    ChannelInboundInvoker fireChannelInactive();

    /**
     * 通道 Channel在其入站操作中接收到Throwable。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 exceptionCaught(ChannelHandlerContext, Throwable) 方法。
     */
    ChannelInboundInvoker fireExceptionCaught(Throwable cause);

    /**
     * 通道接收到用户定义的事件。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 userEventTriggered(ChannelHandlerContext, Object) 方法。
     */
    ChannelInboundInvoker fireUserEventTriggered(Object event);

    /**
     * 通道收到数据。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 channelRead(ChannelHandlerContext, Object) 方法。
     */
    ChannelInboundInvoker fireChannelRead(Object msg);

    /**
     * 通道此次数据接收完成。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 channelReadComplete(ChannelHandlerContext) 方法。
     */
    ChannelInboundInvoker fireChannelReadComplete();

    /**
     * 通道的可写状态发生改变。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个入站处理器 ChannelInboundHandler 的 channelWritabilityChanged(ChannelHandlerContext) 方法。
     */
    ChannelInboundInvoker fireChannelWritabilityChanged();
}
```

> - 你会发现 `ChannelInboundInvoker` 接口也是 `9` 个方法，和 `ChannelInboundHandler` 接口中的方法是一一对应的。
> - 只不过`ChannelInboundHandler` 接口的方法，都回传了当前这个`ChannelInboundHandler`对应的上下文对象 `ChannelHandlerContext`。

# ChannelOutboundHandler 和 ChannelOutboundInvoker

这两个接口相关联：

1. `ChannelOutboundHandler` 用来处理出站`I/O`操作。

2. ```
   ChannelOutboundInvoker
   ```

    用来传递出站

   ```
   I/O
   ```

   操作。

   > - `ChannelOutboundInvoker` 的子接口管道 `ChannelPipeline` , 通过`ChannelOutboundInvoker` 的方法，在整个出站处理器`ChannelOutboundHandler` 链表传递出站`I/O`操作。
   > - `ChannelOutboundInvoker` 的子接口上下文 `ChannelHandlerContext` , 通过`ChannelOutboundInvoker` 的方法，向 `ChannelOutboundHandler` 链表上游传递出站`I/O`操作。
   > - `ChannelOutboundInvoker` 的子接口通道 `Channel`, 它的`ChannelOutboundInvoker` 方法实现，就是直接调用通道 `Channel` 拥有的管道 `ChannelPipeline`对应方法。

## 3.1 `ChannelOutboundHandler` 接口



```dart
/**
 * 用于处理 出站操作的 ChannelHandler
 */
public interface ChannelOutboundHandler extends ChannelHandler {
    /**
     * 将通道绑定到给定的SocketAddress 地址，并在操作完成后通知 ChannelPromise
     */
    void bind(ChannelHandlerContext ctx, SocketAddress localAddress, ChannelPromise promise) throws Exception;

    /**
     * 将通道连接到给定的 remoteAddress 远程地址，同时绑定到localAddress，
     * 并在操作完成后通知 ChannelPromise
     */
    void connect(
            ChannelHandlerContext ctx, SocketAddress remoteAddress,
            SocketAddress localAddress, ChannelPromise promise) throws Exception;

    /**
     * 断开与远程对等端的连接，并在操作完成后通知 ChannelPromise
     */
    void disconnect(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception;

    /**
     * 请求关闭通道，并在操作完成后通知 ChannelPromise
     */
    void close(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception;

    /**
     * 请求注销之前分配的EventExecutor，并在操作完成后通知 ChannelPromise
     */
    void deregister(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception;

    /**
     * 拦截 ChannelHandlerContext.read() 方法，
     * 让通道 Channel 读取数据，
     * 默认实现是 DefaultChannelPipeline 中的内部类 HeadContext 的 read 方法
     *    public void read(ChannelHandlerContext ctx) {
     *             unsafe.beginRead();
     *    }
     * 调用了 unsafe.beginRead() 方法，让通道开始从远端读取数据。
     */
    void read(ChannelHandlerContext ctx) throws Exception;

    /**
     * 在进行写操作时调用。
     * 写操作将通过 ChannelPipeline 写入消息，但只是写入缓存区，
     * 只有调用 Channel.flush() 方法，才可以将它们刷新到实际的Channel
     */
    void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) throws Exception;

    /**
     * 在进行刷新操作时调用。
     * 清除操作将尝试清除所有之前写入的挂起消息，即写缓存区数据。
     */
    void flush(ChannelHandlerContext ctx) throws Exception;
}
```

包括了所有主动的 `IO` 操作：

1. 绑定操作 `bind(...)`
2. 连接操作 `connect(...)`
3. 断开连接操作 `disconnect(...)`
4. 关闭通道 `close(...)`
5. 取消注册 `deregister(...)`
6. 手动让通道从远端拉取数据 `read(...)`
7. 向写缓冲区中写入数据 `write(...)`
8. 将写缓冲区的数据发送到远端 `flush(...)`

## 3.2 `ChannelOutboundInvoker` 接口



```dart
public interface ChannelOutboundInvoker {

    /**
     * 请求绑定到给定的SocketAddress，并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个出站处理器 ChannelOutboundHandler 的 bind(ChannelHandlerContext, SocketAddress, ChannelPromise) 方法。
     */
    ChannelFuture bind(SocketAddress localAddress);

    /**
     * 请求连接到给定的SocketAddress，并在操作完成后通知ChannelFuture (可能是操作成功，也可能是发生了错误)。
     *
     * 如果连接超时导致连接失败，ChannelFuture将使用ConnectTimeoutException 异常。
     * 如果因为连接被拒绝而失败，则会使用ConnectException 异常。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个出站处理器 ChannelOutboundHandler 的 connect(ChannelHandlerContext, SocketAddress, SocketAddress, ChannelPromise) 方法。
     */
    ChannelFuture connect(SocketAddress remoteAddress);

    /**
     * 请求连接到给定的SocketAddress，同时绑定到localAddress，
     * 并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个出站处理器 ChannelOutboundHandler 的 connect(ChannelHandlerContext, SocketAddress, SocketAddress, ChannelPromise) 方法。
     */
    ChannelFuture connect(SocketAddress remoteAddress, SocketAddress localAddress);

    /**
     * 请求断开与远程对等端的连接，并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个出站处理器 ChannelOutboundHandler 的 disconnect(ChannelHandlerContext, ChannelPromise) 方法。
     */
    ChannelFuture disconnect();

    /**
     * 请求关闭通道，并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     * 在通道被关闭之后，就不可能再次重用它了。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个出站处理器 ChannelOutboundHandler 的 close(ChannelHandlerContext, ChannelPromise) 方法。
     */
    ChannelFuture close();

    /**
     * 请求注销之前分配的EventExecutor，并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     *
     * 这个方法会调用
     * 此通道 Channel 对应的管道 ChannelPipeline 中
     * 下一个出站处理器 ChannelOutboundHandler 的 deregister(ChannelHandlerContext, ChannelPromise) 方法。
     */
    ChannelFuture deregister();

    /**
     * 请求绑定到给定的SocketAddress，并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)，
     * 给定的ChannelPromise 也将被通知。
     */
    ChannelFuture bind(SocketAddress localAddress, ChannelPromise promise);

    /**
     * 请求连接到给定的SocketAddress，并在操作完成后通知ChannelFuture (可能是操作成功，也可能是发生了错误)，
     * 给定的ChannelPromise 也将被通知。
     */
    ChannelFuture connect(SocketAddress remoteAddress, ChannelPromise promise);

    /**
     * 请求连接到给定的SocketAddress，同时绑定到localAddress，
     * 并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     * 给定的ChannelPromise 也将被通知。
     */
    ChannelFuture connect(SocketAddress remoteAddress, SocketAddress localAddress, ChannelPromise promise);

    /**
     * 请求断开与远程对等端的连接，并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     * 给定的ChannelPromise 也将被通知。
     */
    ChannelFuture disconnect(ChannelPromise promise);

    /**
     * 请求关闭通道，并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     * 给定的ChannelPromise 也将被通知。
     * 在通道被关闭之后，就不可能再次重用它了。
     */
    ChannelFuture close(ChannelPromise promise);

    /**
     * 请求注销之前分配的EventExecutor，并在操作完成后通知ChannelFuture(可能是操作成功，也可能是发生了错误)。
     * 给定的ChannelPromise 也将被通知。
     */
    ChannelFuture deregister(ChannelPromise promise);

    /**
     * 从通道读取数据到第一个入站缓冲区的请求，将触发ChannelInboundHandler。
     * 如果数据被读取，则会触发channelRead(ChannelHandlerContext, Object)事件，
     * 并触发channelReadComplete事件，以便处理程序可以决定继续读取。
     *
     * 如果已经有一个挂起的读操作，这个方法什么也不做。
     */
    ChannelOutboundInvoker read();

    /**
     * Request to write a message via this {@link ChannelHandlerContext} through the {@link ChannelPipeline}.
     * This method will not request to actual flush, so be sure to call {@link #flush()}
     * once you want to request to flush all pending data to the actual transport.
     *
     * 请求通过这个 ChannelHandlerContext 通过ChannelPipeline写入消息。
     * 此方法不会请求实际的刷新，因此当您希望请求将所有挂起的数据刷新到实际传输时，请确保调用flush()。
     */
    ChannelFuture write(Object msg);

    /**
     * 请求通过这个ChannelHandlerContext通过ChannelPipeline写入消息。
     * 此方法不会请求实际的刷新，因此当您希望请求将所有挂起的数据刷新到实际传输时，请确保调用flush()。
     */
    ChannelFuture write(Object msg, ChannelPromise promise);

    /**
     * 通过此 ChannelOutboundInvoker 请求刷新所有挂起的消息。
     */
    ChannelOutboundInvoker flush();

    /**
     * 相当于调用 write(Object, ChannelPromise) 和 flush()
     */
    ChannelFuture writeAndFlush(Object msg, ChannelPromise promise);

    /**
     * 相当于调用 write(Object) 和 flush()
     */
    ChannelFuture writeAndFlush(Object msg);

    /**
     * 返回一个新的 ChannelPromise
     */
    ChannelPromise newPromise();

    /**
     * 返回一个新的 ChannelProgressivePromise
     */
    ChannelProgressivePromise newProgressivePromise();

    /**
     * 创建一个标记为已成功新的 ChannelFuture，ChannelFuture.isSuccess()将返回 true。
     * 因为已成功，即该ChannelFuture已完成，
     * 所有添加到它的FutureListener都会被直接通知。而且，每个阻塞方法的调用都将返回没有阻塞的结果。
     */
    ChannelFuture newSucceededFuture();

    /**
     * 创建一个标记为已失败新的 ChannelFuture，ChannelFuture.isSuccess()将返回false。
     * 因为已失败，即该ChannelFuture已完成，
     * 所有添加到它的FutureListener都会被直接通知。而且，每个阻塞方法的调用都将返回没有阻塞的结果。
     */
    ChannelFuture newFailedFuture(Throwable cause);

    /**
     * 返回一个特殊的ChannelPromise，它可以被不同的操作重用。
     * 它只支持在 ChannelOutboundInvoker#write(Object, ChannelPromise) 时使用。
     *
     * 请注意，返回的ChannelPromise不支持大多数操作，只有在希望为每个写操作保存对象分配时才应该使用。
     * 您将无法检测操作是否完成，只有当它失败的时候，将调用ChannelPipeline.fireExceptionCaught(Throwable) 知道失败信息。
     *
     * 请注意，这是一个高级特性，应该小心使用!
     */
    ChannelPromise voidPromise();
}
```

`ChannelOutboundInvoker` 中大部分方法都是触发 `ChannelOutboundHandler` 中对应方法，只不过多了几个创建 `ChannelFuture` 实例的方法。

# 四. 适配器类

## 4.1 `ChannelHandlerAdapter` 抽样类



```java
/**
 * ChannelHandler的框架实现
 */
public abstract class ChannelHandlerAdapter implements ChannelHandler {

    /**
     * 用这个变量保证，已经添加到管道的ChannelHandler 同一实例，
     * 除非它是被 @Sharable 注解的，否则不能再次添加到管道中。
     */
    boolean added;

    /**
     * 如果 isSharable() 返回true，抛出 IllegalStateException 异常
     */
    protected void ensureNotSharable() {
        if (isSharable()) {
            throw new IllegalStateException("ChannelHandler " + getClass().getName() + " is not allowed to be shared");
        }
    }

    /**
     * 如果返回 true，表示这个 ChannelHandler 被 @Sharable 注解的，也就是说可共享的。
     * 可以多次添加到一个或多个管道 ChannelPipeline。
     */
    public boolean isSharable() {
        /**
         * See <a href="https://github.com/netty/netty/issues/2289">#2289</a>.
         */
        Class<?> clazz = getClass();
        Map<Class<?>, Boolean> cache = InternalThreadLocalMap.get().handlerSharableCache();
        Boolean sharable = cache.get(clazz);
        if (sharable == null) {
            sharable = clazz.isAnnotationPresent(Sharable.class);
            cache.put(clazz, sharable);
        }
        return sharable;
    }

    /**
     * 默认情况下什么也不做，子类可能会覆盖这个方法。
     */
    @Override
    public void handlerAdded(ChannelHandlerContext ctx) throws Exception {
        // 什么都不做
    }

    /**
     * 默认情况下什么也不做，子类可能会覆盖这个方法。
     */
    @Override
    public void handlerRemoved(ChannelHandlerContext ctx) throws Exception {
        // 什么都不做
    }

    /**
     * 调用 ChannelHandlerContext.fireExceptionCaught(Throwable)
     * 来转发到 ChannelPipeline 中的下一个 ChannelHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    @Deprecated
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) throws Exception {
        // 通过 ctx.fireExceptionCaught(cause) 方法，向下传递异常
        ctx.fireExceptionCaught(cause);
    }
}
```

这个类主要为 `ChannelHandler` 的注解 `@Sharable` 实现提供方便，我们在 `DefaultChannelPipeline` 类的`checkMultiplicity` 方法中看到:



```java
    private static void checkMultiplicity(ChannelHandler handler) {
        if (handler instanceof ChannelHandlerAdapter) {
            // 如果是 ChannelHandlerAdapter 的子类
            ChannelHandlerAdapter h = (ChannelHandlerAdapter) handler;
            // 只有 ChannelHandler 是可共享的，才能多次添加，
            // 否则 handler 已被添加(h.added == true) 的情况下，直接抛出异常
            if (!h.isSharable() && h.added) {
                throw new ChannelPipelineException(
                        h.getClass().getName() +
                        " is not a @Sharable handler, so can't be added or removed multiple times.");
            }
            h.added = true;
        }
    }
```

这个方法在每次管道添加 `ChannelHandler` 时，都会调用，保证 `ChannelHandler` 实例不会多次添加，除非它是可共享的。

## 4.2 `ChannelInboundHandlerAdapter`,`ChannelOutboundHandlerAdapter`和`ChannelDuplexHandler`



```dart
public class ChannelInboundHandlerAdapter extends ChannelHandlerAdapter implements ChannelInboundHandler {

    /**
     * 调用 ChannelHandlerContext.fireChannelRegistered() 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void channelRegistered(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelRegistered();
    }

    /**
     * 调用 ChannelHandlerContext.fireChannelUnregistered() 方法
     * 来转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void channelUnregistered(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelUnregistered();
    }

    /**
     * 调用 ChannelHandlerContext.fireChannelActive() 方法
     * 来转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void channelActive(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelActive();
    }

    /**
     * 调用 ChannelHandlerContext.fireChannelInactive() 方法
     * 来转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void channelInactive(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelInactive();
    }

    /**
     * 调用 ChannelHandlerContext.fireChannelRead(Object) 方法
     * 来转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) throws Exception {
        ctx.fireChannelRead(msg);
    }

    /**
     * 调用 ChannelHandlerContext.fireChannelReadComplete() 方法
     * 来转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void channelReadComplete(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelReadComplete();
    }

    /**
     * 调用 ChannelHandlerContext.fireUserEventTriggered(Object) 方法
     * 来转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
        ctx.fireUserEventTriggered(evt);
    }

    /**
     * 调用 ChannelHandlerContext.fireChannelWritabilityChanged() 方法
     * 来转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void channelWritabilityChanged(ChannelHandlerContext ctx) throws Exception {
        ctx.fireChannelWritabilityChanged();
    }

    /**
     * 调用 ChannelHandlerContext.fireExceptionCaught(Throwable) 方法
     * 来转发到 ChannelPipeline 中的下一个 ChannelInboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    @SuppressWarnings("deprecation")
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause)
            throws Exception {
        ctx.fireExceptionCaught(cause);
    }
}
```



```dart
public class ChannelOutboundHandlerAdapter extends ChannelHandlerAdapter implements ChannelOutboundHandler {

    /**
     * 调用 ChannelHandlerContext.bind(SocketAddress, ChannelPromise) 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelOutboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void bind(ChannelHandlerContext ctx, SocketAddress localAddress,
            ChannelPromise promise) throws Exception {
        ctx.bind(localAddress, promise);
    }

    /**
     * 调用 ChannelHandlerContext.connect(SocketAddress, SocketAddress, ChannelPromise) 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelOutboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void connect(ChannelHandlerContext ctx, SocketAddress remoteAddress,
            SocketAddress localAddress, ChannelPromise promise) throws Exception {
        ctx.connect(remoteAddress, localAddress, promise);
    }

    /**
     * 调用 ChannelHandlerContext.disconnect(ChannelPromise) 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelOutboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void disconnect(ChannelHandlerContext ctx, ChannelPromise promise)
            throws Exception {
        ctx.disconnect(promise);
    }

    /**
     * 调用 ChannelHandlerContext.close(ChannelPromise) 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelOutboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void close(ChannelHandlerContext ctx, ChannelPromise promise)
            throws Exception {
        ctx.close(promise);
    }

    /**
     * 调用 ChannelHandlerContext.deregister(ChannelPromise) 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelOutboundHandler。
     *
     * 子类可以重写方法来改变行为。
     */
    @Skip
    @Override
    public void deregister(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception {
        ctx.deregister(promise);
    }

    /**
     * 调用 ChannelHandlerContext.read() 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelOutboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void read(ChannelHandlerContext ctx) throws Exception {
        ctx.read();
    }

    /**
     * 调用 ChannelHandlerContext.write(Object, ChannelPromise) 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelOutboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) throws Exception {
        ctx.write(msg, promise);
    }

    /**
     * 调用 ChannelHandlerContext.flush() 方法
     * 以转发到 ChannelPipeline 中的下一个 ChannelOutboundHandler。
     *
     * 子类可以重写这个方法来改变行为。
     */
    @Skip
    @Override
    public void flush(ChannelHandlerContext ctx) throws Exception {
        ctx.flush();
    }
}
```



```java
public class ChannelDuplexHandler extends ChannelInboundHandlerAdapter implements ChannelOutboundHandler {

    @Skip
    @Override
    public void bind(ChannelHandlerContext ctx, SocketAddress localAddress,
                     ChannelPromise promise) throws Exception {
        ctx.bind(localAddress, promise);
    }

    @Skip
    @Override
    public void connect(ChannelHandlerContext ctx, SocketAddress remoteAddress,
                        SocketAddress localAddress, ChannelPromise promise) throws Exception {
        ctx.connect(remoteAddress, localAddress, promise);
    }

    @Skip
    @Override
    public void disconnect(ChannelHandlerContext ctx, ChannelPromise promise)
            throws Exception {
        ctx.disconnect(promise);
    }

    @Skip
    @Override
    public void close(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception {
        ctx.close(promise);
    }

    @Skip
    @Override
    public void deregister(ChannelHandlerContext ctx, ChannelPromise promise) throws Exception {
        ctx.deregister(promise);
    }

    @Skip
    @Override
    public void read(ChannelHandlerContext ctx) throws Exception {
        ctx.read();
    }

    @Skip
    @Override
    public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) throws Exception {
        ctx.write(msg, promise);
    }

    @Skip
    @Override
    public void flush(ChannelHandlerContext ctx) throws Exception {
        ctx.flush();
    }
}
```

> - 方法实现都是调用当前 `ChannelHandler` 上下文对象的对应方法， 来转发到 `ChannelPipeline` 中的下一个 `ChannelHandler`。
> - 子类可以重写这个方法来改变行为。

你会发现这些方法都有一个 `@Skip` 注解，它的作用就是带有这个注解的事件处理器方法不会被`ChannelPipeline`调用，直接跳过它，寻找管道中下一个事件处理器。

# 五. ChannelHandlerMask 类

这个类就是用来处理  `@Skip` 注解。



```java
final class ChannelHandlerMask {
    private static final InternalLogger logger = InternalLoggerFactory.getInstance(ChannelHandlerMask.class);

    /*
     * 用来标记 ChannelHandler 中的方法，包括入站事件方法和出站事件方法，
     * 使用 int 整数类型的二进制表示不同的方法
     */
    // 标记 exceptionCaught 方法，                      1
    static final int MASK_EXCEPTION_CAUGHT = 1;
    // 标记 channelRegistered 方法，                   10
    static final int MASK_CHANNEL_REGISTERED = 1 << 1;
    // 标记 channelUnregistered 方法，                100
    static final int MASK_CHANNEL_UNREGISTERED = 1 << 2;
    // 标记 channelActive 方法，                     1000
    static final int MASK_CHANNEL_ACTIVE = 1 << 3;
    // 标记 channelInactive 方法，                  10000
    static final int MASK_CHANNEL_INACTIVE = 1 << 4;
    // 标记 channelRead 方法，                     100000
    static final int MASK_CHANNEL_READ = 1 << 5;
    // 标记 channelReadComplete 方法，            1000000
    static final int MASK_CHANNEL_READ_COMPLETE = 1 << 6;
    // 标记 userEventTriggered 方法，            10000000
    static final int MASK_USER_EVENT_TRIGGERED = 1 << 7;
    // 标记 channelWritabilityChanged 方法，    100000000
    static final int MASK_CHANNEL_WRITABILITY_CHANGED = 1 << 8;
    // 标记 bind 方法，                        1000000000
    static final int MASK_BIND = 1 << 9;
    // 标记 connect 方法，                    10000000000
    static final int MASK_CONNECT = 1 << 10;
    // 标记 disconnect 方法，                100000000000
    static final int MASK_DISCONNECT = 1 << 11;
    // 标记 close 方法，                    1000000000000
    static final int MASK_CLOSE = 1 << 12;
    // 标记 deregister 方法，              10000000000000
    static final int MASK_DEREGISTER = 1 << 13;
    // 标记 read 方法，                   100000000000000
    static final int MASK_READ = 1 << 14;
    // 标记 write 方法，                 1000000000000000
    static final int MASK_WRITE = 1 << 15;
    // 标记 flush 方法，                10000000000000000
    static final int MASK_FLUSH = 1 << 16;

    // 包括仅仅包括入站事件方法的标记，就是排除异常方法 exceptionCaught 的标记 MASK_EXCEPTION_CAUGHT
    static final int MASK_ONLY_INBOUND =  MASK_CHANNEL_REGISTERED |
            MASK_CHANNEL_UNREGISTERED | MASK_CHANNEL_ACTIVE | MASK_CHANNEL_INACTIVE | MASK_CHANNEL_READ |
            MASK_CHANNEL_READ_COMPLETE | MASK_USER_EVENT_TRIGGERED | MASK_CHANNEL_WRITABILITY_CHANGED;
    // 所有的入站事件方法的标记，也就是多了 MASK_EXCEPTION_CAUGHT 标记
    private static final int MASK_ALL_INBOUND = MASK_EXCEPTION_CAUGHT | MASK_ONLY_INBOUND;
    // 包括仅仅包括出站事件方法的标记，就是排除异常方法 exceptionCaught 的标记 MASK_EXCEPTION_CAUGHT
    static final int MASK_ONLY_OUTBOUND =  MASK_BIND | MASK_CONNECT | MASK_DISCONNECT |
            MASK_CLOSE | MASK_DEREGISTER | MASK_READ | MASK_WRITE | MASK_FLUSH;
    // 所有的出站事件方法的标记，也就是多了 MASK_EXCEPTION_CAUGHT 标记
    private static final int MASK_ALL_OUTBOUND = MASK_EXCEPTION_CAUGHT | MASK_ONLY_OUTBOUND;

    // 用来缓存， ChannelHandler 子类对应的执行标记 mask
    // 这样就不用每次都需要计算了，消耗 CPU 事件
    private static final FastThreadLocal<Map<Class<? extends ChannelHandler>, Integer>> MASKS =
            new FastThreadLocal<Map<Class<? extends ChannelHandler>, Integer>>() {
                @Override
                protected Map<Class<? extends ChannelHandler>, Integer> initialValue() {
                    return new WeakHashMap<Class<? extends ChannelHandler>, Integer>(32);
                }
            };

    /**
     * 返回这个 ChannelHandler 子类clazz 对应的执行标记 executionMask；
     * 优先从线程缓存中获取，如果没有那么通过 mask0(clazz) 计算出执行标记，
     * 并将它存储到线程缓存中，然后返回它。
     */
    static int mask(Class<? extends ChannelHandler> clazz) {
        // 首先尝试从缓存中获取执行标记
        Map<Class<? extends ChannelHandler>, Integer> cache = MASKS.get();
        Integer mask = cache.get(clazz);
        if (mask == null) {
            mask = mask0(clazz);
            cache.put(clazz, mask);
        }
        return mask;
    }

    /**
     * 计算执行标记 executionMask
     */
    private static int mask0(Class<? extends ChannelHandler> handlerType) {
        int mask = MASK_EXCEPTION_CAUGHT;
        try {
            // 判断是不是属于入站事件处理器 ChannelInboundHandler 的子类
            if (ChannelInboundHandler.class.isAssignableFrom(handlerType)) {
                // 先将所有的入站事件方法的标记 MASK_ALL_INBOUND 赋值给它，
                // 然后在看这个子类 handlerType 中，有没有被 @Skip 标记的方法，
                // 那么就通过位运算排除它。
                mask |= MASK_ALL_INBOUND;

                // channelRegistered 方法有没有被 @Skip 注解修饰，
                // 返回 true，表示被@Skip 注解修饰，那么就通过位运算，
                // 从当前标记中删除这个方法的标记
                if (isSkippable(handlerType, "channelRegistered", ChannelHandlerContext.class)) {
                    mask &= ~MASK_CHANNEL_REGISTERED;
                }
                if (isSkippable(handlerType, "channelUnregistered", ChannelHandlerContext.class)) {
                    mask &= ~MASK_CHANNEL_UNREGISTERED;
                }
                if (isSkippable(handlerType, "channelActive", ChannelHandlerContext.class)) {
                    mask &= ~MASK_CHANNEL_ACTIVE;
                }
                if (isSkippable(handlerType, "channelInactive", ChannelHandlerContext.class)) {
                    mask &= ~MASK_CHANNEL_INACTIVE;
                }
                if (isSkippable(handlerType, "channelRead", ChannelHandlerContext.class, Object.class)) {
                    mask &= ~MASK_CHANNEL_READ;
                }
                if (isSkippable(handlerType, "channelReadComplete", ChannelHandlerContext.class)) {
                    mask &= ~MASK_CHANNEL_READ_COMPLETE;
                }
                if (isSkippable(handlerType, "channelWritabilityChanged", ChannelHandlerContext.class)) {
                    mask &= ~MASK_CHANNEL_WRITABILITY_CHANGED;
                }
                if (isSkippable(handlerType, "userEventTriggered", ChannelHandlerContext.class, Object.class)) {
                    mask &= ~MASK_USER_EVENT_TRIGGERED;
                }
            }

            // 判断是不是属于入站事件处理器 ChannelOutboundHandler 的子类
            // 处理逻辑和上面一样
            if (ChannelOutboundHandler.class.isAssignableFrom(handlerType)) {
                mask |= MASK_ALL_OUTBOUND;

                if (isSkippable(handlerType, "bind", ChannelHandlerContext.class,
                        SocketAddress.class, ChannelPromise.class)) {
                    mask &= ~MASK_BIND;
                }
                if (isSkippable(handlerType, "connect", ChannelHandlerContext.class, SocketAddress.class,
                        SocketAddress.class, ChannelPromise.class)) {
                    mask &= ~MASK_CONNECT;
                }
                if (isSkippable(handlerType, "disconnect", ChannelHandlerContext.class, ChannelPromise.class)) {
                    mask &= ~MASK_DISCONNECT;
                }
                if (isSkippable(handlerType, "close", ChannelHandlerContext.class, ChannelPromise.class)) {
                    mask &= ~MASK_CLOSE;
                }
                if (isSkippable(handlerType, "deregister", ChannelHandlerContext.class, ChannelPromise.class)) {
                    mask &= ~MASK_DEREGISTER;
                }
                if (isSkippable(handlerType, "read", ChannelHandlerContext.class)) {
                    mask &= ~MASK_READ;
                }
                if (isSkippable(handlerType, "write", ChannelHandlerContext.class,
                        Object.class, ChannelPromise.class)) {
                    mask &= ~MASK_WRITE;
                }
                if (isSkippable(handlerType, "flush", ChannelHandlerContext.class)) {
                    mask &= ~MASK_FLUSH;
                }
            }

            // "exceptionCaught" 方法需要单独判断，
            // 因为 ChannelInboundHandler 和 ChannelOutboundHandler 都有它
            if (isSkippable(handlerType, "exceptionCaught", ChannelHandlerContext.class, Throwable.class)) {
                mask &= ~MASK_EXCEPTION_CAUGHT;
            }
        } catch (Exception e) {
            // Should never reach here.
            PlatformDependent.throwException(e);
        }

        return mask;
    }

    /**
     * 这个类的 methodName 方法(包括它父类中的方法)
     * 是不是被 @Skip 注解修饰，如果被修饰，就返回 true
     *
     */
    @SuppressWarnings("rawtypes")
    private static boolean isSkippable(
            final Class<?> handlerType, final String methodName, final Class<?>... paramTypes) throws Exception {
        return AccessController.doPrivileged(new PrivilegedExceptionAction<Boolean>() {
            @Override
            public Boolean run() throws Exception {
                Method m;
                try {
                    // 通过 getMethod 返回的方法，包括父类中的方法
                    m = handlerType.getMethod(methodName, paramTypes);
                } catch (NoSuchMethodException e) {
                    if (logger.isDebugEnabled()) {
                        logger.debug(
                            "Class {} missing method {}, assume we can not skip execution", handlerType, methodName, e);
                    }
                    return false;
                }
                // 当前方法是否有 Skip 注解
                return m.isAnnotationPresent(Skip.class);
            }
        });
    }

    private ChannelHandlerMask() { }

    /**
     * 表示 ChannelHandler 中的带注释的事件处理器方法不会被 ChannelPipeline 调用，
     * 因此必须仅在 ChannelHandler 方法除了转发到管道中的下一个 ChannelHandler 之外不做任何事情时才能使用。
     */
    @Target(ElementType.METHOD)
    @Retention(RetentionPolicy.RUNTIME)
    @interface Skip {
        // no value
    }
}
```

使用 `int` 类型的不同位标记 `ChannelHandler` 的不同方法，包括所有入站事件方法和出站事件方法。
 例如一个 `ChannelInboundHandler` 的子类:

> - 它首先拥有所有入站事件方法的标记 `MASK_ALL_INBOUND`, 如果它的某些入站事件方法被`@Skip` 修饰，那么就将这个方法对应的标记从当前标记中移除。
> - 最后得到一个执行标记 `executionMask`，记录这个类事件方法是否被`@Skip` 修饰，通过它就可以判断需要跳过这个方法。