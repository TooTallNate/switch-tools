export declare enum VideoCapture {
    Disabled = 0,
    Enabled = 1,
    Automatic = 2
}
export declare class NACP {
    buffer: ArrayBuffer;
    dataView: DataView;
    constructor(buffer?: ArrayBuffer);
    get title(): string;
    set title(v: string);
    get author(): string;
    set author(v: string);
    get version(): string;
    set version(v: string);
    set id(v: string | bigint);
    get id(): bigint;
    /**
     * Whether or not to display the user account picker
     * when booting up the application.
     */
    set startupUserAccount(v: number);
    get startupUserAccount(): number;
    set screenshot(v: number);
    get screenshot(): number;
    set videoCapture(v: VideoCapture);
    get videoCapture(): VideoCapture;
    /**
     * Text shown above logo during boot-up.
     *   - Value of 0: "Licensed by"
     *   - Value of 1: "Distributed by"
     *   - Anything else: no text shown
     */
    set logoType(v: number);
    get logoType(): number;
    set logoHandling(v: number);
    get logoHandling(): number;
}
