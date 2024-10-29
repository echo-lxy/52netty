import { defineConfig } from "vitepress"

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "52Netty",
  description: "www.52netty.com",
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

    footer: {
      message: "基于 MIT 许可发布",
      copyright: `版权所有 © 2023-${new Date().getFullYear()} 李新洋`,
    },

    docFooter: {
      prev: "上一页",
      next: "下一页",
    },

    outline: {
      label: "页面导航",
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
        link: "/netty_source_code_parsing/ready_to_go/instructions",
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
              { text: "本书说明", link: "/ready_to_go/instructions" },
              {
                text: "梳理 Netty 整体架构脉络",
                link: "/ready_to_go/architecture_of_netty",
              },
              {
                text: "Java NIO 详解",
                link: "/ready_to_go/java_nio",
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
                    text: "从内核角度看 IO 模型",
                    link: "/main_task/network_communication_layer/io_model_io_thread_model",
                  },
                  {
                    text: "IO 多路复用的操作系统支持",
                    link: "/main_task/network_communication_layer/io_multiplexing_support_by_operating_system.md",
                  },
                ],
              },
              {
                text: "启动引导层",
                items: [
                  {
                    text: "创建主从 Reactor Group",
                    link: "/main_task/boot_layer/io_model_io_thread_model.md",
                  },
                  {
                    text: "启动主从 Reactor Group ",
                    link: "/main_task/boot_layer/bootstrap_launch_reactor_group.md",
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
            items: [],
          },
          {
            text: "第四部分：其他特性",
            collapsed: true,
            items: [],
          },
        ],
      },
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/echo-lxy/52netty" },
    ],
  },
})
