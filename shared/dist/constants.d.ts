export interface TextNodeDefaults {
    width: number;
    height: number;
    color: string;
    fontSize: number;
    titleAlign: 'left' | 'center' | 'right';
    collapsedTitleAlign: 'left' | 'center' | 'right';
    contentAlign: 'left' | 'center' | 'right';
}
export interface ImageNodeDefaults {
    width: number;
    height: number;
    fontSize: number;
    titleAlign: 'left' | 'center' | 'right';
    collapsedTitleAlign: 'left' | 'center' | 'right';
}
export interface NodeDefaults {
    textNode: TextNodeDefaults;
    imageNode: ImageNodeDefaults;
}
export declare const SHARED_NODE_DEFAULTS: {
    readonly textNode: {
        readonly width: 200;
        readonly height: 120;
        readonly color: "#ffffff";
        readonly fontSize: 14;
        readonly titleAlign: "left";
        readonly collapsedTitleAlign: "left";
        readonly contentAlign: "left";
    };
    readonly imageNode: {
        readonly width: 200;
        readonly height: 150;
        readonly fontSize: 14;
        readonly titleAlign: "left";
        readonly collapsedTitleAlign: "left";
    };
};
export declare const NODE_DEFAULTS_VALIDATION: {
    readonly textNode: {
        readonly minWidth: 100;
        readonly maxWidth: 1000;
        readonly minHeight: 60;
        readonly maxHeight: 1000;
        readonly minFontSize: 10;
        readonly maxFontSize: 36;
    };
    readonly imageNode: {
        readonly minWidth: 100;
        readonly maxWidth: 1000;
        readonly minHeight: 60;
        readonly maxHeight: 1000;
        readonly minFontSize: 10;
        readonly maxFontSize: 36;
    };
};
//# sourceMappingURL=constants.d.ts.map