# 《图解 Netty 源码》简介

::: warning 注意

本教程以 Netty **4.1.56Final** 版本为基准进行讲解

:::

## 如何阅读

大家好，我是 Echo，是 [图解 Netty](https://www.52netty.com/) 的站长。本教程的内容主要围绕 Netty 的原理和源码进行剖析。

简单介绍一下[《图解 Netty 源码》](/netty_source_code_parsing/ready_to_go/introduce)，整个内容大约 30 万字，当然不全是我手写的，我也引用了很多优质的网上资料来辅助讲解。本教程参考的所有资料都放在了本文最后，如有冒犯，欢迎指出，我会立即删除。

[《图解 Netty 源码》](/netty_source_code_parsing/ready_to_go/introduce)不仅涵盖 Netty 源码的内容，还深入探讨了 **是什么、为什么、怎么用** 这三大问题，当然，源码讲解的占比是最大的。

如果想阅读 Netty 实战相关内容，请移步【TODO】

::: warning 注意

如果您有任何问题，请在本站的 [Github](https://github.com/echo-lxy/52netty) 中提交 issue

:::

笔者认为整个教学的规划还是较为合理的：

1. **第一部分**：简单介绍 Netty，并梳理 Netty 的整体架构
2. **第二部分**：Java NIO 系列教程，这是基础哈
3. **第三部分（核心部分）**：我将对整个 Netty 的逻辑架构进行分层讲解

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202411121039277.png?x-oss-process=image/watermark,image_aW1nL3dhdGVyLnBuZw==,g_nw,x_1,y_1" alt="image-20241112103919098" style="zoom: 33%;" />

3. **第四部分**：Netty 如此受欢迎的另外一个主要的原因是其优秀的内存管理机制，所以笔者在这对其进行剖析
4. **第五、六部分**：为了更好地理解 Netty，还会有一系列副本任务。这些任务包括分析理解 Netty 中其他优秀的源码，以及探讨一些特性，例如拆包、零拷贝、心跳机制等。

所以，我们的主要任务是先把主线走完，再打副本。

## 适合谁

[《图解 Netty 源码》](/netty_source_code_parsing/ready_to_go/introduce)不仅仅是对 Netty 源码的解析，还深入探讨了其 **是什么、为什么、怎么用**。我认为，相比网络上零散的 Netty 知识点，更建议你跟随 Echo 理解 Netty 的整个体系。这样在学习其他源码时，你会更加得心应手，并且具备更好的延展性。

对优秀源码的学习往往让 Java 小白感到畏惧，因为它与我们平常的编码大相径庭。所以我在本教程中融入大量简约的图片辅助学习。

**在阅读本书之前，希望您已经对 操作系统、计算机网络 和 Java 编程语言 有了一定的了解。**

其实，在完善本站的过程中，Echo 也经历了很多迷茫，但随着日复一日的学习与总结，逐渐有种拨云见日的感觉。

但我不敢保证[《图解 Netty 源码》](/netty_source_code_parsing/ready_to_go/introduce)中的所有内容都是正确的，因为我仍处于学习阶段，但我会坚持努力，争取在不久的将来，使本教程成为有关 Netty 的优质解读。

**如果大家在阅读过程中发现内容不完善、不正确，或编排不合适，欢迎在本站的 GitHub 上提交 issue，任何您觉得有问题的反馈都是非常宝贵的，我会在 24 小时内处理。**

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410291327748.png" alt="image-20241029132749699" style="zoom: 67%;" />

另外，每篇文章末尾都有如下图所示的超链接，点击后即可在 Github 上对当前文章内容进行修正，

![image-20241029132716321](https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410291327346.png)

**非常感谢您对本站所做的贡献！！！**

## 源码阅读环境搭建

首先，从 [Netty 代码仓库](https://github.com/netty/netty) clone 源代码到本地：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410291256023.png" alt="img" style="zoom:80%;" />

接下来，由于本教程以 **4.1.56Final** 版本为基准进行讲解，我们需要将本地的 Git 版本回滚至此版本。可以使用以下命令进行回滚：

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410291256039.png" alt="img" style="zoom:67%;" />

这样就和本教程的版本一致了，可以开始根据书中的内容进行学习和实践。

<img src="https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410291256984.png" alt="img" style="zoom:67%;" />

对 然后就可以开始了！

## 参考资料【侵权立删】

::: danger 侵权立删

本书部分内容版权归属原作者，如有问题，有劳您留言联系删除

:::

- bin 的技术小屋 【微信公众号】
- 开发内功修炼【微信公众号】
- [Netty: Home](https://netty.io/)
- [GitHub - sanshengshui/netty-learning-example: :egg: Netty 实践学习案例，见微知著！带着你的心，跟着教程。我相信你行欧。](https://github.com/sanshengshui/netty-learning-example)
- [GitHub - yongshun/learn_netty_source_code: Netty 源码分析教程](https://github.com/yongshun/learn_netty_source_code)
- [Introduction · Essential Netty in Action 《Netty 实战(精髓)》](https://waylau.gitbooks.io/essential-netty-in-action/content/)
- [跟闪电侠学 Netty：Netty 即时聊天实战与底层原理 (豆瓣)](https://book.douban.com/subject/35752082/)
- [Netty 核心原理剖析与 RPC 实践-完](https://learn.lianglianglee.com/专栏/Netty 核心原理剖析与 RPC 实践-完)
- [netty/netty at netty-4.1.56.Final](https://github.com/netty/netty/tree/netty-4.1.56.Final)
- [小林 coding](https://xiaolincoding.com/)
- [netty - 文集 - 简书](https://www.jianshu.com/nb/41207414)
- [主页 | 二哥的 Java 进阶之路](https://javabetter.cn/)
- [NIO-概览 - 杰哥很忙 - 博客园](https://www.cnblogs.com/Jack-Blog/p/11991240.html)
- [Netty.docs: Related articles](https://netty.io/wiki/related-articles.html)
