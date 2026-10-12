from insightface.app import FaceAnalysis


def main():
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    print("InsightFace buffalo_l model cached")


if __name__ == "__main__":
    main()
