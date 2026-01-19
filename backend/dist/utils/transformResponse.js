import { transformDateFields, transformDateFieldsArray } from './dateTransform.js';
function toCamelCase(obj) {
    const result = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            const value = obj[key];
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                result[camelKey] = toCamelCase(value);
            }
            else if (Array.isArray(value)) {
                result[camelKey] = value.map(item => typeof item === 'object' && item !== null ? toCamelCase(item) : item);
            }
            else {
                result[camelKey] = value;
            }
        }
    }
    return result;
}
export function transformResponse(obj, dateFields = []) {
    const camelCased = toCamelCase(obj);
    if (dateFields.length > 0) {
        return transformDateFields(camelCased, dateFields);
    }
    return camelCased;
}
export function transformResponseArray(arr, dateFields = []) {
    const camelCased = arr.map(item => toCamelCase(item));
    if (dateFields.length > 0) {
        return transformDateFieldsArray(camelCased, dateFields);
    }
    return camelCased;
}
