export const SHARED_NODE_DEFAULTS = {
    textNode: {
        width: 200,
        height: 160,
        color: '#ffffff',
        fontSize: 14,
        titleAlign: 'left',
        collapsedTitleAlign: 'left',
        contentAlign: 'left',
    },
    imageNode: {
        width: 200,
        height: 160,
        fontSize: 14,
        titleAlign: 'left',
        collapsedTitleAlign: 'left',
    },
};
export const NODE_DEFAULTS_VALIDATION = {
    textNode: {
        minWidth: 100,
        maxWidth: 1000,
        minHeight: 60,
        maxHeight: 1000,
        minFontSize: 10,
        maxFontSize: 36,
    },
    imageNode: {
        minWidth: 100,
        maxWidth: 1000,
        minHeight: 60,
        maxHeight: 1000,
        minFontSize: 10,
        maxFontSize: 36,
    },
};
