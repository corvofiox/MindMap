export function transformDateFields(obj, dateFields) {
    const result = { ...obj };
    for (const field of dateFields) {
        const value = result[field];
        if (value === null || value === undefined) {
            continue;
        }
        if (typeof value === 'object' && value !== null && 'getTime' in value) {
            const dateValue = value;
            if (!isNaN(dateValue.getTime())) {
                result[field] = dateValue.toISOString();
            }
            continue;
        }
        if (typeof value === 'number') {
            if (value > 1000000000000) {
                result[field] = new Date(value).toISOString();
            }
            else if (value > 1000000000) {
                result[field] = new Date(value * 1000).toISOString();
            }
            else {
                result[field] = new Date().toISOString();
            }
            continue;
        }
        if (typeof value === 'string') {
            const date = new Date(value);
            if (!isNaN(date.getTime())) {
                result[field] = date.toISOString();
            }
        }
    }
    return result;
}
export function transformDateFieldsArray(arr, dateFields) {
    return arr.map((item) => transformDateFields(item, dateFields));
}
