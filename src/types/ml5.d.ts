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
    detect(video: HTMLVideoElement): Promise<HandPoseResult[]>;
    detectStart(
      video: HTMLVideoElement,
      callback: (results: HandPoseResult[]) => void,
    ): void;
    detectStop?(): void;
  }

  interface Ml5Api {
    handPose(
      options: {
        maxHands: number;
        flipped: boolean;
        modelType: "lite";
        runtime: "tfjs";
      },
    ): Promise<HandPoseModel> | HandPoseModel;
  }

  const ml5: Ml5Api;
  export = ml5;
}
