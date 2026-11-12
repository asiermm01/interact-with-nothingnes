declare module "ml5" {
  interface HandPoseKeypoint {
    x: number;
    y: number;
    z?: number;
    name: string;
    score?: number;
    confidence?: number;
  }

  interface HandPoseResult {
    keypoints?: HandPoseKeypoint[];
    confidence?: number;
    score?: number;
    handedness?: string;
    label?: string;
  }

  interface HandPoseModel {
    ready: Promise<unknown>;
    detect(image: HTMLVideoElement | HTMLCanvasElement): Promise<HandPoseResult[]>;
    detectStop?(): void;
  }

  interface TensorFlowRuntime {
    ready(): Promise<void>;
    getBackend(): string;
  }

  interface Ml5Api {
    tf: TensorFlowRuntime;
    handPose(
      options: {
        maxHands: 2;
        flipped: boolean;
        modelType: "full";
        runtime: "tfjs";
      },
    ): Promise<HandPoseModel> | HandPoseModel;
  }

  const ml5: Ml5Api;
  export = ml5;
}
