// =============================================================================
// TomeRestriction.js  –  Modular Tome Restriction system for FactionCreator
// =============================================================================
// This file is entirely self-contained.  It exposes a single global:
//   window.TomeRestriction
//
// Required ONE-LINE hooks already added to Faction.js:
//   1. SetTomePathOptions, after list is built:
//        if (window.TomeRestriction && TomeRestriction.isEnabled()) list = TomeRestriction.filterTomes(list, tomeInsertionIndex);
//   2. SetRandomStart, after RecalculateStats(false) in the else-branch:
//        if (window.TomeRestriction) TomeRestriction.onRandomize();
//   3. selectTomePath, after toggleOriginButtons():
//        if (window.TomeRestriction && TomeRestriction.isEnabled()) TomeRestriction.updateDisplay();
//
// Required HTML in FactionCreator.html (already added):
//   - <input type="checkbox" id="tomeRestrictionToggle">  (near Tome Path header)
//   - <div id="tomeRestrictionDisplay">                   (below Tome Path header)
// =============================================================================

window.TomeRestriction = (function () {
    "use strict";

    // ── State ─────────────────────────────────────────────────────────────────
    var distribution = null;  // { 1:n, 2:n, 3:n, 4:n, 5:1 }  total slots per tier
    var lockedTier5  = null;  // tome object determined at randomize time
    var baseAff      = null;  // { tag: count } map from culture+societies only (no tomes/extras)

    // ── Public API ────────────────────────────────────────────────────────────

    function isEnabled() {
        var cb = document.getElementById("tomeRestrictionToggle");
        return !!(cb && cb.checked);
    }

    /** Called when the toggle checkbox changes. */
    function onToggle(checked) {
        var el = document.getElementById("tomeRestrictionDisplay");
        if (!checked) {
            distribution = null;
            lockedTier5  = null;
            baseAff      = null;
            if (el) el.style.display = "none";
        } else if (!distribution) {
            if (el) el.style.display = "block";
            onRandomize();  // Auto-randomize immediately instead of showing prompt
        }
    }

    /** Called by SetRandomStart (hook #2) after RecalculateStats. */
    function onRandomize() {
        if (!isEnabled()) return;
        distribution = _generateDistribution();
        baseAff = _parseAffinityTotal(_computeBaseAffinities());
        lockedTier5  = _selectTier5Tome();
        updateDisplay();
    }

    /**
     * Filters the tome list shown in the picker popup.
     * Called by SetTomePathOptions (hook #1).
     * @param {Array}   list           - tomes from GetNextSetOfTomes
     * @param {number}  insertionIndex - current tomeInsertionIndex from Faction.js
     * @param {boolean} isReplacement  - true if replacing an existing tome
     */
    function filterTomes(list, insertionIndex, isReplacement) {
        if (!distribution) return list;

        // Position in the final list (0-based).
        // New tome:     insertPos = insertionIndex + 1  (slot after last tome)
        // Replacement:  insertPos = insertionIndex      (same slot, affinity from before it)
        var insertPos = (insertionIndex === undefined || insertionIndex < 0)
            ? currentTomeList.length
            : isReplacement ? insertionIndex : insertionIndex + 1;

        // ── Final slot (#9): locked T5 or fallback ──────────────────────────
        if (insertPos === 8) {
            if (!lockedTier5) {
                return list.filter(function (t) { return t.tier === 5; });
            }
            // Locked T5 is available → use it
            if (isInArray(list, lockedTier5)) {
                return [lockedTier5];
            }
            // Requirements not met for locked T5 → fallback:
            // ANY tier, ignoring quotas, but MUST share affinity with the locked T5
            var t5AffElts = _getTomeAffinityElements(lockedTier5);
            var fallback = [];
            for (var fi = 0; fi < list.length; fi++) {
                var t = list[fi];
                var tElts = _getTomeAffinityElements(t);
                if (tElts.length === 0) continue;
                if (tElts.some(function (e) { return t5AffElts.indexOf(e) !== -1; })) {
                    fallback.push(t);
                }
            }
            return fallback.length > 0 ? fallback : [lockedTier5];
        }

        // ── Check if T5 is already selected ────────────────────────────────────
        var tier5Selected = isTier5Selected();

        // When replacing, exclude the replaced tome from tier counts
        var tomesForCount = isReplacement
            ? currentTomeList.filter(function (_, idx) { return idx !== insertionIndex; })
            : currentTomeList;
        var currentCounts  = _getTierCounts(tomesForCount);
        var affAtInsertion = _getAffinityAtIndex(insertPos);
        var playerElements = _getPlayerElements(affAtInsertion);

        // 1. Quota constraint: FREED after T5 selected, otherwise apply quota
        if (!tier5Selected) {
            // Before T5 selected: apply normal quota restrictions
            list = list.filter(function (t) {
                var quota = distribution[t.tier] || 0;
                if (quota === 0 ) return false;
                return (currentCounts[t.tier] || 0) < quota;
            });
        } else {
            // After T5 selected: quotas freed for T1-T4, but block other T5
            list = list.filter(function (t) {
                if (t.tier === 5) return false;  // No more T5 tomes allowed
                return true;                      // T1-T4 quotas are freed
            });
        }

        // 2. Only tomes whose affinity elements match the player's element set
        list = list.filter(function (t) {
            return _tomeElementsMatchPlayer(t, playerElements);
        });

        // 3. Exclude tomes that would violate affinity ordering
        list = list.filter(function (t) {
            return !_wouldViolateAffinityOrder(t, affAtInsertion);
        });

        // 3b. Hybrid tome rule: tomes with 2+ affinities require ALL their affinities.
        //     Fallback: if no non-hybrid tomes remain for a tier, allow hybrids
        //     matching at least 1 affinity.
        var hybridList = [], nonHybridList = [];
        for (var hi = 0; hi < list.length; hi++) {
            if (_isHybridTome(list[hi])) {
                hybridList.push(list[hi]);
            } else {
                nonHybridList.push(list[hi]);
            }
        }
        if (hybridList.length > 0 && nonHybridList.length > 0) {
            // There are non-hybrid options — filter hybrids strictly.
            // Keep a hybrid only if player has ALL its affinities.
            list = nonHybridList.concat(hybridList.filter(function (ht) {
                return _hasAllHybridAffinities(affAtInsertion, ht);
            }));
        }
        // If nonHybridList is empty, keep all hybrids as-is (fallback).

        // 4. Never show the locked T5 tome before the final slot
        if (lockedTier5) {
            list = list.filter(function (t) { return t !== lockedTier5; });
        }

        list = [...new Set(list)];

        return list;
    }

    /** Re-renders the distribution progress bar below the Tome Path header. */
    function updateDisplay() {
        var el = document.getElementById("tomeRestrictionDisplay");
        if (!el) return;
        if (!distribution || !isEnabled()) {
            el.style.display = "none";
            return;
        }
        el.style.display = "block";
        el.innerHTML = _buildDisplayHtml();
    }

    // ── Distribution Generation ───────────────────────────────────────────────

    /**
     * Randomly builds a { 1:n1, 2:n2, 3:n3, 4:n4, 5:1 } distribution where:
     *   n1 + n2 + n3 + n4 = 8,  n1 >= 1,  n5 = 1  (always one T5)
     * Pre-requisite constraints kept so the path is achievable:
     *   n2 > 0  →  n1 >= 2         (need 2 tomes before first T2)
     *   n3 > 0  →  n1+n2 >= 4      (need 4 tomes before first T3)
     *   n4 > 0  →  n1+n2+n3 >= 6   (need 6 tomes before first T4)
     */
    function _generateDistribution() {
        var n1, n2, n3, n4, tries = 0;
        do {
            n1 = _rand(1, 5);
            n2 = _rand(0, Math.min(4, 8 - n1));
            n3 = _rand(0, Math.min(3, 8 - n1 - n2));
            n4 = 8 - n1 - n2 - n3;
            tries++;
            if (n4 < 0)                       continue;
            if (n2 > 0 && n1 < 2)             continue;
            if (n3 > 0 && n1 + n2 < 4)        continue;
            if (n4 > 0 && n1 + n2 + n3 < 6)   continue;
            break;
        } while (tries < 200);
        return { 1: n1, 2: n2, 3: n3, 4: n4, 5: 1 };
    }

    /**
     * Picks the T5 tome based on BASE affinities only
     * (culture + societies + subtype/subculture — no tomes, no extra affinity points).
     * Hybrid T5 tomes that contain the primary element also qualify.
     * If multiple elements are tied for highest, one is chosen at random.
     */
    /**
     * Counts the number of distinct affinity elements in a tome's affinities string.
     * e.g. "1 <empirearcana>… 1 <empirechaos>…" → 2
     */
    function _countDistinctAffinities(tome) {
        if (!tome || !tome.affinities) return 0;
        var c = _parseTomeContrib(tome.affinities), keys = Object.keys(c), n = 0;
        for (var i = 0; i < keys.length; i++) { if (c[keys[i]] > 0) n++; }
        return n;
    }

    /**
     * Returns true if the player has every possible affinity element with at least 1 point.
     * Checks for the standard 6: empirearcana, empirechaos, empirenature,
     * empirematter, empireorder, empireshadow.
     */
    function _hasAllAffinities(affinityStr) {
        var map = _parseAffinityTotal(affinityStr);
        var required = ["empirearcana","empirechaos","empirenature","empirematter","empireorder","empireshadow"];
        for (var i = 0; i < required.length; i++) {
            if (!map[required[i]] || map[required[i]] < 1) return false;
        }
        return true;
    }

    /**
     * Returns true if the player has at least 1 point in every affinity element
     * that this tome contributes to.  e.g. a Chaos+Shadow hybrid tome requires
     * the player to have both Chaos ≥1 and Shadow ≥1.
     */
    function _playerHasAllTomeAffinities(tome, affinityStr) {
        if (!tome || !tome.affinities) return true;
        var playerMap = _parseAffinityTotal(affinityStr);
        var contrib   = _parseTomeContrib(tome.affinities);
        var tomeElts  = Object.keys(contrib).filter(function (k) { return contrib[k] > 0; });
        for (var i = 0; i < tomeElts.length; i++) {
            if (!playerMap[tomeElts[i]] || playerMap[tomeElts[i]] < 1) return false;
        }
        return true;
    }

    function _selectTier5Tome() {
        // Base affinity = culture + societies + first tome + subtype (same as green number)
        var affStr      = _computeBaseAffinities();
        var topElements = _getTopAffinityElements(affStr);

        // All T5 tomes that have affinities (no special exclusions)
        var allT5 = (typeof jsonTomes !== "undefined" ? jsonTomes : []).filter(function (t) {
            return t.tier === 5 && t.affinities;
        });

        if (!allT5.length) return null;

        // Separate into: all-affinity (≥6 elements), other-hybrid (2-5), mono (1)
        var allAffTomes   = [];  // tomes with all 6 affinity elements
        var hybridTomes   = [];  // tomes with 2-5 affinity elements
        var monoTomes     = [];  // tomes with a single affinity element

        for (var i = 0; i < allT5.length; i++) {
            var cnt = _countDistinctAffinities(allT5[i]);
            if (cnt >= 6)       allAffTomes.push(allT5[i]);
            else if (cnt >= 2)  hybridTomes.push(allT5[i]);
            else                monoTomes.push(allT5[i]);
        }

        // ── Rule: if player has ALL 6 affinities → always the all-affinity tome ──
        if (_hasAllAffinities(affStr) && allAffTomes.length > 0) return _pick(allAffTomes);

        // ── Other hybrid T5 tomes (50% chance) ──────────────────────────
        var hybridPool = hybridTomes.filter(function (t) {
            return _tomeHasAnyElement(t, topElements) && _playerHasAllTomeAffinities(t, affStr);
        });
        if (hybridPool.length > 0 && Math.random() < 0.50) return _pick(hybridPool);

        // ── Default: mono tomes matching the HIGHEST base affinity ───────
        var monoPool = monoTomes.filter(function (t) { return _tomeHasAnyElement(t, topElements); });
        if (!monoPool.length) monoPool = monoTomes;
        if (monoPool.length > 0) return _pick(monoPool);

        // ── Ultimate fallback: any T5 (top-affinity first) ───────────────
        var pool = allT5.filter(function (t) { return _tomeHasAnyElement(t, topElements); });
        return _pick(pool.length > 0 ? pool : allT5);
    }

    // ── Affinity Helpers ──────────────────────────────────────────────────────

    /**
     * Returns the affinity total from culture + societies + subtype + FIRST TOME only —
     * same as the "green number" (base affinity) shown in the UI.  No extras, no later tomes.
     */
    function _computeBaseAffinities() {
        // Temporarily zero out the extra-affinity globals defined in Faction.js
        var sO = extraOrder,    sC = extraChaos,   sN = extraNature,
            sM = extraMaterium, sSh = extraShadow, sA = extraAstral;
        extraOrder = extraChaos = extraNature = extraMaterium = extraShadow = extraAstral = 0;

        // Include only the first tome (the one from the random draw), like the green number
        var firstTome = (typeof currentTomeList !== "undefined" && currentTomeList.length > 0)
            ? [currentTomeList[0]] : [];

        var r = GetAffinityTotalFromList(
            GetCurrentChoiceList(), firstTome,
            currentSubType, currentSubCulture,
            currentSubSociety1, currentSubSociety2
        );

        extraOrder = sO; extraChaos = sC; extraNature = sN;
        extraMaterium = sM; extraShadow = sSh; extraAstral = sA;
        return r;
    }

    /**
     * Returns the affinity total string simulating the state just before the tome
     * at position `index` would be added (i.e. using tomes 0..index-1 only).
     * Includes extra affinity points (they are always active).
     */
    function _getAffinityAtIndex(index) {
        return GetAffinityTotalFromList(
            GetCurrentChoiceList(),
            currentTomeList.slice(0, index),
            currentSubType, currentSubCulture,
            currentSubSociety1, currentSubSociety2
        );
    }

    /**
     * Parses a GetAffinityTotalFromList result string into a { tag: count } map.
     * Input format: " <empirearcana></empirearcana> 3  <empireorder></empireorder> 2 …"
     */
    function _parseAffinityTotal(str) {
        var map = {}, re = /<(\w+)><\/\1>\s*(\d+)/g, m;
        while ((m = re.exec(str)) !== null) map[m[1]] = parseInt(m[2], 10);
        return map;
    }

    /**
     * Parses a tome `affinities` field into a { tag: pointCount } contribution map.
     * Input format: "1 <empirearcana></empirearcana> Empire Astral Affinity, …"
     */
    function _parseTomeContrib(str) {
        var map = {}, re = /(\d+)\s+<(\w+)><\/\2>/g, m;
        while ((m = re.exec(str)) !== null) {
            var k = m[2], v = parseInt(m[1], 10);
            map[k] = (map[k] || 0) + v;
        }
        return map;
    }

    /** Affinity element tags of a tome (e.g. ["empirearcana"]). */
    function _getTomeAffinityElements(tome) {
        if (!tome || !tome.affinities) return [];
        var c = _parseTomeContrib(tome.affinities), keys = Object.keys(c), out = [];
        for (var i = 0; i < keys.length; i++) { if (c[keys[i]] > 0) out.push(keys[i]); }
        return out;
    }

    /** Returns the mono element of the T5 if it's mono, null otherwise. */
    function _getT5MonoElement() {
        if (!lockedTier5 || !lockedTier5.affinities) return null;
        var elts = _getTomeAffinityElements(lockedTier5);
        return elts.length === 1 ? elts[0] : null;
    }

    /** Returns all affinity element tags whose count is > 0. */
    function _getPlayerElements(affinityStr) {
        var map = _parseAffinityTotal(affinityStr), keys = Object.keys(map), out = [];
        for (var i = 0; i < keys.length; i++) { if (map[keys[i]] > 0) out.push(keys[i]); }
        return out;
    }

    /** Returns the element tag(s) with the highest count. */
    function _getTopAffinityElements(affinityStr) {
        var map = _parseAffinityTotal(affinityStr), keys = Object.keys(map);
        if (!keys.length) return [];
        var max = map[keys[0]], i;
        for (i = 1; i < keys.length; i++) { if (map[keys[i]] > max) max = map[keys[i]]; }
        var out = [];
        for (i = 0; i < keys.length; i++) { if (map[keys[i]] === max) out.push(keys[i]); }
        return out;
    }

    /** Does at least ONE of the tome's elements exist in the player's set? */
    function _tomeElementsMatchPlayer(tome, playerElements) {
        if (!tome.affinities) return true;
        var c = _parseTomeContrib(tome.affinities), keys = Object.keys(c);
        for (var i = 0; i < keys.length; i++) {
            if (c[keys[i]] > 0 && playerElements.indexOf(keys[i]) !== -1) return true;
        }
        return keys.length === 0;
    }

    /**
     * Returns true if picking this tome would violate the affinity ordering.
     *
     * Two constraints are checked:
     *  1. BASE constraint (fixes the "tie" bug): the ordering established by the
     *     initial base affinities (culture+societies, no tomes) must never be
     *     broken — even if two affinities later become tied in the running total.
     *     e.g. base has Chaos=3 > Order=1 → nxt[chaos] must always remain >= nxt[order].
     *
     *  2. RUNNING constraint: if the running total already has A > B (A got ahead
     *     via earlier tome picks), then nxt[A] must remain >= nxt[B].
     */
    function _wouldViolateAffinityOrder(tome, currentAffinityStr) {
        if (!tome.affinities) return false;
        var cur     = _parseAffinityTotal(currentAffinityStr);
        var contrib = _parseTomeContrib(tome.affinities);
        var nxt     = _buildNextTotals(cur, contrib);
        var t5Mono  = _getT5MonoElement();
        var i, j, a, b;

        // 1. Base constraint: baseAff[a] > baseAff[b]  →  nxt[a] >= nxt[b]
        if (baseAff) {
            var bKeys = Object.keys(baseAff);
            for (i = 0; i < bKeys.length; i++) {
                for (j = 0; j < bKeys.length; j++) {
                    if (i === j) continue;
                    a = bKeys[i]; b = bKeys[j];
                    // If the "lower" element is the T5 mono, skip —
                    // the T5's element can freely surpass others in base order.
                    if (t5Mono && b === t5Mono) continue;
                    if ((baseAff[a] || 0) > (baseAff[b] || 0) &&
                        (nxt[a]    || 0) <  (nxt[b]    || 0)) return true;
                }
            }
        }

        // 2. Running constraint: cur[a] > cur[b]  →  nxt[a] >= nxt[b]
        var cKeys = Object.keys(cur);
        for (i = 0; i < cKeys.length; i++) {
            for (j = 0; j < cKeys.length; j++) {
                if (i === j) continue;
                a = cKeys[i]; b = cKeys[j];
                // T5 mono can freely surpass others in running order too
                if (t5Mono && b === t5Mono) continue;
                if (cur[a] > cur[b] && (nxt[a] || 0) < (nxt[b] || 0)) return true;
            }
        }

        // 3. T5 mono absolute protection: no element can surpass the T5's element
        if (t5Mono) {
            var t5Val = nxt[t5Mono] || 0;
            for (i = 0; i < cKeys.length; i++) {
                var other = cKeys[i];
                if (other === t5Mono) continue;
                if ((nxt[other] || 0) > t5Val) return true;
            }
        }

        return false;
    }

    /** Merge cur + contrib into hypothetical post-tome totals. */
    function _buildNextTotals(cur, contrib) {
        var nxt = {}, keys = Object.keys(cur), i, k;
        for (i = 0; i < keys.length; i++) { nxt[keys[i]] = cur[keys[i]]; }
        keys = Object.keys(contrib);
        for (i = 0; i < keys.length; i++) { k = keys[i]; nxt[k] = (nxt[k] || 0) + contrib[k]; }
        return nxt;
    }

    // ── Tier Count Helpers ────────────────────────────────────────────────────

    function _getTierCounts(list) {
        var c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        for (var i = 0; i < list.length; i++) { var t = list[i].tier; if (c[t] !== undefined) c[t]++; }
        return c;
    }

    // ── Display HTML ──────────────────────────────────────────────────────────

    function _buildDisplayHtml() {
        var counts  = _getTierCounts(currentTomeList);
        var romans  = ["", "I", "II", "III", "IV", "V"];
        var colors  = { 1: "#b5b5b1", 2: "#a3c4e0", 3: "#90c090", 4: "#d4a030", 5: "#e07070" };
        var filled  = "#4caf50";
        var empty   = "#333";

        var html = '<div style="display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 2px 0;align-items:center;">';
        html += '<span style="color:#d7c297;font-family:\'Decorative\';font-size:12px;' +
                'white-space:nowrap;margin-right:2px;">Restrictions:</span>';

        for (var tier = 1; tier <= 5; tier++) {
            var total = distribution[tier] || 0;
            if (total === 0) continue;
            var used  = Math.min(counts[tier] || 0, total);
            var slots = "";
            for (var d = 0; d < total; d++) {
                slots += '<span style="font-size:14px;margin:0 1px;color:' +
                         (d < used ? filled : empty) + ';">&#9632;</span>';
            }

            html += '<div style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;' +
                    'background:rgba(255,255,255,0.06);border-radius:3px;border:1px solid #3a3a3a;">';
            html += '<span style="color:' + colors[tier] + ';font-family:\'Decorative\';' +
                    'font-size:12px;min-width:22px;text-align:center;">' + romans[tier] + '</span>';
            html += slots;

            if (tier === 5 && lockedTier5) {
                var shortName = lockedTier5.name
                    .replace("Tome of the ", "").replace("Tome of ", "").trim();
                html += '<img src="/aow4db/Icons/TomeIcons/' + lockedTier5.icon + '.png" ' +
                        'height="18px" style="margin-left:5px;vertical-align:middle;" ' +
                        'title="' + _esc(lockedTier5.name) + '">';
                html += '<span style="color:#e07070;font-size:11px;white-space:nowrap;' +
                        'font-family:\'Regular\';">' + _esc(shortName) + '</span>';
            }
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    function _esc(s) {
        return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
                .replace(/"/g,"&quot;");
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    /** Random element from array. */
    function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    /** True if tome.affinities contains at least one element from the list. */
    function _tomeHasAnyElement(tome, elements) {
        for (var i = 0; i < elements.length; i++) {
            if (tome.affinities.indexOf(elements[i]) !== -1) return true;
        }
        return false;
    }

    /** Returns true if the tome has 2+ distinct affinity tags (hybrid). */
    function _isHybridTome(tome) {
        if (!tome || !tome.affinities) return false;
        var tags = tome.affinities.match(/<(\w+)><\/\1>/g);
        if (!tags || tags.length < 2) return false;
        var seen = {};
        for (var i = 0; i < tags.length; i++) { seen[tags[i]] = true; }
        return Object.keys(seen).length >= 2;
    }

    /** Returns true if the player has at least 1 point in EVERY affinity of the hybrid tome. */
    function _hasAllHybridAffinities(affinityStr, tome) {
        if (!tome || !tome.affinities) return true;
        var tags = tome.affinities.match(/<(\w+)><\/\1>/g);
        if (!tags) return true;
        var seen = {};
        for (var i = 0; i < tags.length; i++) { seen[tags[i]] = true; }
        var distinct = Object.keys(seen);
        for (var j = 0; j < distinct.length; j++) {
            var m = affinityStr.match(new RegExp(distinct[j] + '\\s*(\\d+)'));
            if (!m || parseInt(m[1]) < 1) return false;
        }
        return true;
    }

    // ── Init ─────────────────────────────────────────────────────────────────

    document.addEventListener("DOMContentLoaded", function () {
        var cb = document.getElementById("tomeRestrictionToggle");
        if (cb) cb.addEventListener("change", function () { onToggle(this.checked); });
    });

    // ── Public Interface ──────────────────────────────────────────────────────
    /** Returns the locked T5 tome, or null if not set. */
    function getTier5() {
        return lockedTier5;
    }

    /** Returns the current distribution { 1:n, 2:n, 3:n, 4:n, 5:1 }, or null if not set. */
    function getDistribution() {
        return distribution;
    }

    /** Sets the distribution directly (used for loading from URL). */
    function setDistribution(n1, n2, n3, n4) {
        if (!distribution) {
            distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 };
        }
        distribution[1] = n1;
        distribution[2] = n2;
        distribution[3] = n3;
        distribution[4] = n4;
        updateDisplay();
    }

    /**
     * Restores full state from URL parameters without re-randomizing.
     * @param {number} n1 - Tier 1 quota
     * @param {number} n2 - Tier 2 quota
     * @param {number} n3 - Tier 3 quota
     * @param {number} n4 - Tier 4 quota
     * @param {string} tier5Id - ID of the locked T5 tome (may be null/undefined)
     */
    function restoreState(n1, n2, n3, n4, tier5Id) {
        // Set distribution (force creation if null)
        if (!distribution) {
            distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 };
        }
        distribution[1] = n1;
        distribution[2] = n2;
        distribution[3] = n3;
        distribution[4] = n4;

        // Restore locked T5 tome if ID provided
        if (tier5Id && typeof jsonTomes !== "undefined") {
            for (var i = 0; i < jsonTomes.length; i++) {
                if (jsonTomes[i].id === tier5Id) {
                    lockedTier5 = jsonTomes[i];
                    break;
                }
            }
        }

        // Capture base affinities from current state (culture+societies only)
        baseAff = _parseAffinityTotal(_computeBaseAffinities());

        var el = document.getElementById("tomeRestrictionDisplay");
        if (el) el.style.display = "block";
        updateDisplay();
    }

    // ── Check if T5 is selected ──────────────────────────────────────────────
    function isTier5Selected() {
        return !!(lockedTier5 && isInArray(currentTomeList, lockedTier5));
    }

    /**
     * Re-selects the T5 tome based on current affinities WITHOUT changing the
     * tier distribution. Called when Culture/Society/Ruler/Form changes and
     * Tome Restriction is already active.
     */
    function reSelectTier5() {
        if (!isEnabled() || !distribution) return;
        // Use BASE affinities only (culture+societies, no tomes) to preserve ordering
        baseAff = _parseAffinityTotal(_computeBaseAffinities());
        lockedTier5 = _selectTier5Tome();
        updateDisplay();
    }

    return {
        isEnabled:     isEnabled,
        onToggle:      onToggle,
        onRandomize:   onRandomize,
        filterTomes:   filterTomes,
        updateDisplay: updateDisplay,
        getTier5:      getTier5,
        getDistribution: getDistribution,
        setDistribution: setDistribution,
        restoreState:  restoreState,
        reSelectTier5: reSelectTier5,
        isTier5Selected: isTier5Selected
    };
})();
