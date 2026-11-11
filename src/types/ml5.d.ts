declare module "ml5" {
  interface HandPoseKeypoint {
    x: number;
    y: number;
    z?: number;
    name: string;
    score?: number;
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
    detectStart(
      video: HTMLVideoElement,
      callback: (results: HandPoseResult[]) => void,
    ): void;
    detectStop?(): void;
  }

  interface Ml5Api {
    handPose(
      options: { maxHands: number; flipped: boolean },
    ): Promise<HandPoseModel> | HandPoseModel;
  }

  const ml5: Ml5Api;
  export = ml5;
}
