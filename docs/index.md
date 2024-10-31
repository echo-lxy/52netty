---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

title: 图解Netty
titleTemplate: 图解Netty

hero:
  name: "图解Netty"
  text: "Netty 源码解析&实战"
  tagline: 一个优质的 Netty 学习网站
  actions:
    - theme: brand
      text: 开始阅读
      link: /netty_source_code_parsing/ready_to_go/introduce
    - theme: alt
      text: 代码仓库
      link: https://github.com/echo-lxy/52netty
  image:
    src: https://echo798.oss-cn-shenzhen.aliyuncs.com/img/202410291205474.png
    alt: 52Netty

features:
  - title: Feature A
    details: Lorem ipsum dolor sit amet, consectetur adipiscing elit
  - title: Feature B
    details: Lorem ipsum dolor sit amet, consectetur adipiscing elit
  - title: Feature C
    details: Lorem ipsum dolor sit amet, consectetur adipiscing elit
---

<style>
:root {
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: -webkit-linear-gradient(120deg, #13227a 20%, #8991bd); /* 深蓝色渐变 */

  --vp-home-hero-image-background-image: linear-gradient(-40deg, #13227a 20%, #ffffff 50%); /* 深蓝和白色渐变 */

  --vp-home-hero-image-filter: blur(44px);
}

@media (min-width: 640px) {
  :root {
    --vp-home-hero-image-filter: blur(56px);
  }
}

@media (min-width: 960px) {
  :root {
    --vp-home-hero-image-filter: blur(68px);
  }
}
</style>
