import p5 from "p5";

type InitParams = {
    setup?: () => void;
    draw?: () => void;
    windowResized?: () => void;
    keyPressed?: () => void;
}

export function initP5(params: InitParams) {
    Object.assign(window, params);
    const P5 = p5 as unknown as { new (): p5 };
    new P5();
}
