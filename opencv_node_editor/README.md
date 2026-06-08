# OpenCV 节点式图像处理 MVP

这是一个按照 ComfyUI 风格实现的工业图像处理拖拽式 Demo。
当前只内置一个算法节点：**形态学操作**。

## 功能

- 浏览器节点画布
- 拖拽添加「形态学操作」节点
- 点击端口连线
- 参数面板实时编辑
- 上传图片或使用内置工业演示图
- 后端使用 OpenCV 执行：
  - 腐蚀 Erode
  - 膨胀 Dilate
  - 开运算 Open
  - 闭运算 Close
  - 形态学梯度 Gradient
  - 顶帽 Top-hat
  - 黑帽 Black-hat

## 安装

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 运行

```bash
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

浏览器打开：

```text
http://127.0.0.1:8000
```

## 目录结构

```text
opencv_node_editor/
├── app.py                 # FastAPI + OpenCV 执行引擎
├── requirements.txt
└── public/
    ├── index.html          # 前端页面
    ├── styles.css          # ComfyUI 风格样式
    └── app.js              # 节点拖拽、连线、参数编辑、调用后端
```

## 后续扩展建议

1. 把 `apply_morphology()` 抽象成统一算法节点接口。
2. 增加边缘检测、阈值分割、轮廓检测、Blob 分析、模板匹配、尺寸测量等工业算法节点。
3. 将当前 MVP 的“顺序执行”升级为真正的 DAG 数据流执行。
4. 增加工业相机输入节点，例如 GigE/USB3 相机 SDK 或 RTSP 视频流。
5. 增加结果判定节点，例如 OK/NG、缺陷面积阈值、尺寸公差判定。
