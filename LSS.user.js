// ==UserScript==
// @name         LongStoryShort Calculator (CSS Overlay + Variables Hidden)
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Вычисления [[выражений]] с overlay, скрытие переменных, текст не меняется в ProseMirror
// @author       Vi
// @match        https://longstoryshort.app/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    let variables = {}; // глобальные переменные (если где-то явно присвоено Y=5)
    let styleTag = document.createElement("style");
    document.head.appendChild(styleTag);

    // Оценивает выражение, в которое уже подставлены все числа и точка/скобки/операторы.
    function evalSafeExpression(expr) {
        try {
            // Разрешаем только цифры, пробелы и базовые операторы/скобки/точка
            if (!/^[0-9+\-*/().\s]+$/.test(expr)) return "⚠️";
            let result = Function('"use strict"; return (' + expr + ')')();
            return (Math.round(result * 100) / 100).toString();
        } catch {
            return "⚠️";
        }
    }

    // создаём селектор вида html > body > div:nth-child(3) > ... > p:nth-child(2)
    function getPathSelector(el) {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1) { // элемент
            const tag = node.tagName.toLowerCase();
            const parent = node.parentNode;
            if (!parent || parent.nodeType !== 1) {
                parts.unshift(tag);
                break;
            }
            // порядковый номер среди element children (nth-child)
            let idx = 1;
            let sib = node;
            while (sib = sib.previousElementSibling) idx++;
            parts.unshift(`${tag}:nth-child(${idx})`);
            if (tag === 'html') break;
            node = parent;
        }
        return parts.join(' > ');
    }

    // Считает сумму по всем {} внутри данного div.
    // Учитывает:
    //  - {123}      -> добавляет 123
    //  - {name=5}   -> добавляет 5
    //  - {NAME}     -> если есть переменная NAME в variablesInDiv или global variables, добавляет её значение
    function computeSumForDiv(div, variablesInDiv) {
        let sum = 0;
        // проход по всем <p> внутри div
        div.querySelectorAll("p").forEach(p2 => {
            let t2 = p2.innerText;

            // {число}
            let matchesNum = [...t2.matchAll(/\{([0-9]+)\}/g)];
            matchesNum.forEach(([full, v]) => sum += Number(v));

            // {NAME=число}
            let matchesAssign = [...t2.matchAll(/\{([\w]+)\s*=\s*([0-9]+)\}/g)];
            matchesAssign.forEach(([full, name, val]) => sum += Number(val));

            // {NAME} (без =): попробуем подставить значение переменной, если она есть
            let matchesName = [...t2.matchAll(/\{([A-Za-z_]\w*)\}/g)];
            matchesName.forEach(([full, name]) => {
                // если это был числовой матч, он уже был учтён в matchesNum; здесь нужны имена
                // проверим наличие в variablesInDiv, затем в глобальных variables
                if (variablesInDiv && variablesInDiv[name] !== undefined) {
                    sum += Number(variablesInDiv[name]);
                } else if (variables[name] !== undefined) {
                    sum += Number(variables[name]);
                }
            });
        });
        return sum;
    }

    function updateCSSForBox(div) {
        // Если в режиме редактирования — ничего не делаем (чтобы не мешать набору)
        if (!div || div.classList.contains("ProseMirror-focused")) return "";

        // Собираем переменные внутри div (например {x=4})
        let variablesInDiv = {};
        Array.from(div.querySelectorAll("p")).forEach(p => {
            let txt = p.innerText;
            let varMatchesAll = [...txt.matchAll(/\{([\w]+)\s*=\s*([0-9]+)\}/g)];
            varMatchesAll.forEach(m => {
                let [, name, val] = m;
                variablesInDiv[name] = Number(val);
            });
        });

        // Предвычислим sum для этого div — пригодится и для чисто [[sum]] и для выражений вида [[sum+$da]]
        const sumValue = computeSumForDiv(div, variablesInDiv);

        const paragraphs = Array.from(div.querySelectorAll("p"));
        const localRules = [];

        paragraphs.forEach((p, index) => {
            let text = p.innerText.trim();
            if (!text) return;
            if (/^[-]{2,}$/.test(text)) return;

            // Найдём все [[...]] в абзаце
            const exprMatches = [...text.matchAll(/\[\[(.+?)\]\]/g)];
            if (exprMatches.length === 0) return;

            let replaced = text;
            exprMatches.forEach(match => {
                let expr = match[1].trim();

                // Если выражение ровно "sum" — просто вставим посчитую сумму
                if (expr.toLowerCase() === "sum") {
                    replaced = replaced.replace(match[0], sumValue.toString());
                    return;
                }

                // Иначе — в выражении может быть token "sum" и/или $var переменные:
                // 1) заменим все вхождения слова sum на число
                let ex = expr.replace(/\bsum\b/gi, String(sumValue));

                // 2) подставим $var из variablesInDiv или глобальных variables
                ex = ex.replace(/\$([A-Za-z_]\w*)/g, (_, varName) => {
                    if (variablesInDiv[varName] !== undefined) return String(variablesInDiv[varName]);
                    if (variables[varName] !== undefined) return String(variables[varName]);
                    return "0";
                });

                // 3) ещё допустимо писать переменные без $ внутри {}, но в выражениях обычно используется $.
                // Оставляем выражение и безопасно вычисляем его
                let evalResult = evalSafeExpression(ex);
                replaced = replaced.replace(match[0], evalResult);
            });

            // получаем уникальный путь-селектор до этого p
            let selector = getPathSelector(p);

            // экранируем слэши и кавычки, переводы строки в CSS-совместный вид
            let safeContent = replaced.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, '\\A ');

            // правило: скрываем оригинальный текст и рисуем ::after с результатом
            localRules.push(`
${selector} {
    font-size: 0 !important;
    position: relative;
}
${selector}::after {
    content: "${safeContent}";
    font-size: 14px !important;
    color: hsla(0,0%,100%,.9);
    font-weight: 700;
    display: inline-block;
}
            `);
        });

        return localRules.join("\n");
    }

    function updateAllTextboxes() {
        let css = "";
        document.querySelectorAll('div[role="textbox"]').forEach(div => {
            css += updateCSSForBox(div) + "\n";
        });
        styleTag.innerHTML = css;
    }

    // Обработчики фокуса: при входе в фокус очищаем overlay, при уходе — перестраиваем стили
    document.addEventListener("focusout", (e) => {
        if (e.target && e.target.matches && e.target.matches('div[role="textbox"]')) {
            updateAllTextboxes();
        }
    });

    document.addEventListener("focusin", (e) => {
        if (e.target && e.target.matches && e.target.matches('div[role="textbox"]')) {
            // очищаем overlay, чтобы можно было редактировать оригинальный текст
            styleTag.innerHTML = "";
        }
    });

    // MutationObserver следит за изменениями и обновляет overlay
    let observer = new MutationObserver(() => updateAllTextboxes());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // начальная инициализация
    window.addEventListener("DOMContentLoaded", updateAllTextboxes);

})();
