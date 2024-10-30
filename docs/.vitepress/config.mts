import { defineConfig, type DefaultTheme } from "vitepress"

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "52Netty",
  description: "www.52netty.com",
  lastUpdated: true,
  markdown: {
    math: true,
  },
  head: [
    [
      "link",
      {
        rel: "icon",
        href: "https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410291205474.png",
      },
    ],
  ],
  themeConfig: {
    logo: "https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410291205474.png",
    // https://vitepress.dev/reference/default-theme-config

    editLink: {
      pattern: "https://github.com/echo-lxy/52netty/tree/master/docs/:path",
      text: "在 GitHub 上编辑此页面",
    },
    outline: {
      label: "页面导航",
      level: [2, 3],
    },
    footer: {
      message: "基于 MIT 许可发布",
      copyright: `版权所有 © 2023-${new Date().getFullYear()} 李新洋`,
    },

    docFooter: {
      prev: "上一页",
      next: "下一页",
    },

    lastUpdated: {
      text: "最后更新于",
      formatOptions: {
        dateStyle: "short",
        timeStyle: "medium",
      },
    },

    langMenuLabel: "多语言",
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "菜单",
    darkModeSwitchLabel: "主题",
    lightModeSwitchTitle: "切换到浅色模式",
    darkModeSwitchTitle: "切换到深色模式",

    nav: [
      { text: "首页", link: "/" },
      {
        text: "Netty 源码解析",
        link: "/netty_source_code_parsing/ready_to_go/introduce",
        activeMatch: "/netty_source_code_parsing",
      },
    ],

    sidebar: {
      "/netty_source_code_parsing": {
        base: "/netty_source_code_parsing",
        items: [
          {
            text: "第一部分：整装待发",
            collapsed: true,
            items: [
              {
                text: "Netty 源码深度解析简介",
                link: "/ready_to_go/introduce",
              },
              {
                text: "梳理 Netty 整体架构脉络",
                link: "/ready_to_go/architecture_of_netty",
              },
            ],
          },
          {
            text: "第二部分：主线任务",
            collapsed: true,
            items: [
              {
                text: "网络通信层",
                items: [
                  {
                    text: "Socket 网络编程",
                    link: "/main_task/network_communication_layer/socket_network_programming.md",
                  },
                  {
                    text: "从内核角度看 IO 模型",
                    link: "/main_task/network_communication_layer/io_model",
                  },
                  {
                    text: "IO 多路复用的操作系统支持",
                    link: "/main_task/network_communication_layer/io_multiplexing.md",
                  },
                  {
                    text: "IO 线程模型",
                    link: "/main_task/network_communication_layer/io_thread_model.md",
                  },
                  {
                    text: "Java NIO 详解",
                    link: "/main_task/network_communication_layer/java_nio",
                  },
                ],
              },
              {
                text: "启动引导层",
                items: [
                  {
                    text: "BootStrap 初始化",
                    link: "/main_task/boot_layer/bootstrap_init.md",
                  },
                  {
                    text: "BootStrap 启动 Netty 服务",
                    link: "/main_task/boot_layer/bootstrap_run.md",
                  },
                ],
              },
              {
                text: "事件调度层",
                items: [
                  {
                    text: "Reactor 运转架构",
                    link: "/main_task/event_scheduling_layer/reactor_dispatch.md",
                  },
                  {
                    text: "处理 IO 事件",
                    items: [
                      {
                        text: "EventLoop 操作 IO 事件",
                        link: "/main_task/event_scheduling_layer/io/event_loop_operate_io_event.md",
                      },
                      {
                        text: "处理 OP_CONNECT 事件",
                        link: "/main_task/event_scheduling_layer/io/OP_CONNECT.md",
                      },
                      {
                        text: "处理 OP_ACCEPT 事件",
                        link: "/main_task/event_scheduling_layer/io/OP_ACCEPT.md",
                      },
                      {
                        text: "处理 OP_READ 事件",
                        link: "/main_task/event_scheduling_layer/io/OP_READ.md",
                      },
                      {
                        text: "处理 OP_WRITE 事件",
                        link: "/main_task/event_scheduling_layer/io/OP_WRITE.md",
                      },
                    ],
                  },
                ],
              },
              {
                text: "服务编排层",
                items: [
                  {
                    text: "分拣流水线：Pipline",
                    link: "/main_task/service_orchestration_layer/pipeline.md",
                  },
                  {
                    text: "分拣员：ChannelHandler",
                    link: "/main_task/service_orchestration_layer/channelhandler.md",
                  },
                  {
                    text: "分拣员的工作台：ChannelHandlerContext",
                    link: "/main_task/service_orchestration_layer/ChannelHandlerContext.md",
                  },
                  {
                    text: "货物：被传播的 IO 事件",
                    link: "/main_task/service_orchestration_layer/io_event.md",
                  },
                ],
              },
              {
                text: "番外：内存管理机制",
                items: [
                  {
                    text: "数据载体",
                    items: [
                      {
                        text: "ByteBuf",
                        link: "/main_task/memory_management/data_carrier/ByteBuf.md",
                      },
                    ],
                  },
                  {
                    text: "池化技术",
                    items: [
                      {
                        text: "对象池",
                        link: "/main_task/memory_management/pooling_techniques/object_pool.md",
                      },
                      {
                        text: "内存池",
                        link: "/main_task/memory_management/pooling_techniques/memory_pool.md",
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            text: "第三部分：其他源码分析",
            collapsed: true,
            items: [
              {
                text: "Java NIO Channel",
                link: "/other_source_code/java_nio_channel.md",
              },
              {
                text: "Java NIO Buffer",
                link: "/other_source_code/java_nio_buffer.md",
              },
              {
                text: "Java NIO Selector",
                link: "/other_source_code/java_nio_selector.md",
              },
              {
                text: "promise&future",
                link: "/other_source_code/promise_and_future.md",
              },
            ],
          },
          {
            text: "第四部分：其他特性",
            collapsed: true,
            items: [
              {
                text: "直接内存",
                link: "/other_feature/direct_memory.md",
              },
              {
                text: "心跳机制",
                link: "/other_feature/heartbeat_mechanism.md",
              },
              {
                text: "零拷贝",
                link: "/other_feature/zero_copy.md",
              },
            ],
          },
        ],
      },
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/echo-lxy/52netty" },
    ],

    search: {
      provider: "local",
    },
  },
})