//! Библиотека реплеев: каталог `replays/`, подписи раскладок, варианты, выбор
//! файла под текущую базу и текстовый список для консоли.
//!
//! Здесь нет вызовов Frida: всё, что нужно, приходит сюда параметрами
//! (seed, подпись раскладки), поэтому модуль тестируется на каталоге.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::base::BaseModule;
use crate::replay::load_replay_md;

// Типы формата нужны только тестам этого модуля.
#[cfg(test)]
use std::fs;
#[cfg(test)]
use crate::replay::{save_replay_md, Meta, Replay, ReplayEvent, Trap, SCHEMA};
/// Все .md-реплеи под каталогом replays, свежие первыми.
pub(crate) fn list_replays(root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let Ok(bases) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    for base_dir in bases.flatten() {
        let Ok(files) = std::fs::read_dir(base_dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let mtime = file
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::UNIX_EPOCH);
            found.push((mtime, path));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// Что известно о реплее без его запуска.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Peek {
    base: Option<i64>,
    layout: Option<String>,
    variant: Option<u32>,
    jumps: usize,
    /// Шаги плана по времени (`+400ms`): для них счётчик прыжков равен нулю.
    ms_steps: usize,
    has_state: bool,
}

pub(crate) fn peek_replay_result(path: &Path) -> Result<Peek, String> {
    let replay = load_replay_md(path).map_err(|e| e.to_string())?;
    Ok(Peek {
        base: replay.meta.base,
        layout: replay.meta.layout,
        variant: replay.meta.variant,
        jumps: replay.events.iter().filter(|e| e.name == "jump").count(),
        ms_steps: replay.ms_steps.len(),
        has_state: replay.has_state,
    })
}

/// Как `peek_replay_result`, но нечитаемый файл выглядит как «ничего не известно».
/// Жёсткий вариант нужен там, где о такой файл надо сообщить (список `replays`).
pub(crate) fn peek_replay(path: &Path) -> Peek {
    peek_replay_result(path).unwrap_or_default()
}

/// Один вариант прохождения того же уровня.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReplayVariant {
    pub(crate) path: PathBuf,
    pub(crate) variant: Option<u32>,
    pub(crate) jumps: usize,
    pub(crate) ms_steps: usize,
    pub(crate) has_state: bool,
}

impl ReplayVariant {
    pub(crate) fn from_peek(path: PathBuf, peek: Peek) -> Self {
        Self {
            path,
            variant: peek.variant,
            jumps: peek.jumps,
            ms_steps: peek.ms_steps,
            has_state: peek.has_state,
        }
    }

    pub(crate) fn label(&self) -> String {
        match self.variant {
            Some(n) => format!("вариант {n}"),
            None => "без номера".to_string(),
        }
    }

    /// Строка варианта без префикса: `1) файл — 5 прыжков`.
    pub(crate) fn line(&self, position: usize) -> String {
        format!(
            "{position}) {} — {}{}",
            self.path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?"),
            self.plan_label(),
            if self.has_state { "" } else { ", БЛОКА STATE НЕТ!!!" }
        )
    }

    /// Что внутри: прыжки в кадрах или шаги по времени.
    pub(crate) fn plan_label(&self) -> String {
        if self.ms_steps > 0 {
            format!(
                "{} {} по времени",
                self.ms_steps,
                plural_ru(self.ms_steps, "шаг", "шага", "шагов")
            )
        } else {
            jumps_label(self.jumps)
        }
    }
}

/// Итог поиска записи под текущий макет.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ReplayMatch {
    /// Совпали и скелет (seed), и ловушки (подпись раскладки). Вариантов
    /// прохождения может быть несколько — они отсортированы по номеру.
    Exact(Vec<ReplayVariant>),
    /// Тот же скелет, но расстановка другая: сколько записей и самый свежий файл,
    /// чтобы подсказка показывала реальное имя, а не «<файл>».
    SkeletonOnly { count: usize, newest: PathBuf },
    None,
}

/// Точное совпадение = тот же seed и та же подпись раскладки. Одна подпись без
/// скелета или один скелет без подписи совпадением не считаются: играть по
/// чужой расстановке нельзя.
pub(crate) fn find_replay_for(root: &Path, seed: Option<i64>, layout: Option<&str>) -> ReplayMatch {
    let (Some(seed), Some(layout)) = (seed, layout) else {
        return ReplayMatch::None;
    };
    let mut variants: Vec<ReplayVariant> = Vec::new();
    let mut same_skeleton = 0usize;
    let mut skeleton_newest: Option<PathBuf> = None;
    for path in list_replays(root) {
        let peek = peek_replay(&path);
        if peek.base != Some(seed) {
            continue;
        }
        match peek.layout.as_deref() {
            Some(fp) if fp == layout => {
                variants.push(ReplayVariant::from_peek(path, peek));
            }
            _ => {
                same_skeleton += 1;
                // list_replays отдаёт свежие первыми — первый и запоминаем.
                if skeleton_newest.is_none() {
                    skeleton_newest = Some(path);
                }
            }
        }
    }
    if !variants.is_empty() {
        variants.sort_by(|a, b| {
            a.variant
                .unwrap_or(0)
                .cmp(&b.variant.unwrap_or(0))
                .then_with(|| a.path.cmp(&b.path))
        });
        return ReplayMatch::Exact(variants);
    }
    match skeleton_newest {
        Some(newest) if same_skeleton > 0 => ReplayMatch::SkeletonOnly {
            count: same_skeleton,
            newest,
        },
        _ => ReplayMatch::None,
    }
}

/// Согласование существительного с числом: 1 запись, 2 варианта, 5 вариантов.
pub(crate) fn plural_ru(
    count: usize,
    one: &'static str,
    few: &'static str,
    many: &'static str,
) -> &'static str {
    let last_two = count % 100;
    let last = count % 10;
    if last == 1 && last_two != 11 {
        one
    } else if (2..=4).contains(&last) && !(12..=14).contains(&last_two) {
        few
    } else {
        many
    }
}

pub(crate) fn variants_label(count: usize) -> String {
    format!("{count} {}", plural_ru(count, "запись", "варианта", "вариантов"))
}

pub(crate) fn jumps_label(count: usize) -> String {
    format!("{count} {}", plural_ru(count, "прыжок", "прыжка", "прыжков"))
}

/// Номер следующего варианта для пары (скелет, раскладка). Старые файлы без
/// номера занимают слоты снизу, поэтому нумерация не начинается заново.
pub(crate) fn next_variant(root: &Path, seed: Option<i64>, layout: Option<&str>, dir: &Path, stem: &str) -> u32 {
    let mut max_number = 0u32;
    let mut legacy = 0u32;
    for path in list_replays(root) {
        let peek = peek_replay(&path);
        if peek.base != seed || peek.layout.as_deref() != layout {
            continue;
        }
        match peek.variant {
            Some(n) => max_number = max_number.max(n),
            None => legacy += 1,
        }
    }
    let mut next = max_number.max(legacy) + 1;
    while dir.join(format!("{stem}({next}).md")).exists() {
        next += 1;
    }
    next
}

/// Выбрать файл по известной раскладке: точное совпадение подписи, иначе тот же
/// скелет, иначе самый свежий. Чистая функция по каталогу — без Frida.
pub(crate) fn pick_by_layout(root: &Path, seed: Option<i64>, layout: Option<&str>) -> Option<(PathBuf, String)> {
    let all = list_replays(root);
    if all.is_empty() {
        return None;
    }
    if let Some(layout) = layout {
        for path in &all {
            if peek_replay(path).layout.as_deref() == Some(layout) {
                return Some((path.clone(), format!("совпала подпись раскладки {layout}")));
            }
        }
    }
    if let Some(seed) = seed {
        for path in &all {
            if peek_replay(path).base == Some(seed) {
                return Some((
                    path.clone(),
                    format!("подписи нет, но скелет seed={seed} тот же"),
                ));
            }
        }
    }
    let why = match layout {
        Some(layout) => format!("подписи {layout} нет ни в одном файле — беру самый свежий"),
        None => "раскладку на экране прочитать не удалось — беру самый свежий".to_string(),
    };
    Some((all[0].clone(), why))
}

/// Раскладка базы из модуля base (только чтение).
pub(crate) fn base_layout(base: &mut BaseModule) -> Value {
    match base.ensure_loaded().and_then(|()| base.dungeon_snapshot()) {
        Ok(v) if v.get("ok").and_then(|o| o.as_bool()) == Some(true) => v,
        Ok(v) => {
            eprintln!("WARN main: раскладка базы недоступна: {v}");
            Value::Null
        }
        Err(e) => {
            eprintln!("WARN main: раскладка базы недоступна: {e}");
            Value::Null
        }
    }
}

/// Выбрать реплей под то, что сейчас на экране.
pub(crate) fn pick_replay(root: &Path, base: &mut BaseModule) -> Option<(PathBuf, String)> {
    let live = base_layout(base);
    let seed = live.get("seed").and_then(|v| v.as_i64());
    let live_fp = live
        .get("layout")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    pick_by_layout(root, seed, live_fp.as_deref())
}

/// Разобрать аргумент команды: путь, имя файла внутри replays, или last/newest.
pub(crate) fn resolve_replay_arg(root: &Path, argument: &str) -> Result<PathBuf, String> {
    let direct = PathBuf::from(argument);
    if direct.is_file() {
        return Ok(direct);
    }
    let inside = root.join(argument);
    if inside.is_file() {
        return Ok(inside);
    }
    let wanted = argument.trim().to_ascii_lowercase();
    let all = list_replays(root);
    if wanted == "last" || wanted == "newest" {
        return all
            .into_iter()
            .next()
            .ok_or_else(|| "реплеев нет".to_string());
    }
    let mut names: Vec<String> = Vec::new();
    for path in &all {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.to_ascii_lowercase() == wanted {
            return Ok(path.clone());
        }
        names.push(name);
    }
    Err(format!(
        "файл {argument:?} не найден. Есть: {}",
        names.iter().take(8).cloned().collect::<Vec<_>>().join(", ")
    ))
}

/// PNG, приложенный к реплею: путь из шапки, разрешённый от каталога файла.
pub(crate) fn screenshot_of(replay_md: &Path) -> Option<PathBuf> {
    let replay = load_replay_md(replay_md).ok()?;
    let name = replay.meta.screenshot?;
    let path = replay_md
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(name);
    if !path.is_file() {
        return None;
    }
    // Ссылка относительная и содержит «../»: приводим к нормальному виду, чтобы
    // в консоли был настоящий путь, а не «…/1032192/../images/…».
    Some(std::fs::canonicalize(&path).unwrap_or(path))
}

/// Уже отснятый кадр этой же базы (скелет + подпись раскладки). Второй вариант
/// того же уровня — то же подземелье, снимать заново нечего.
pub(crate) fn existing_screenshot(
    root: &Path,
    seed: Option<i64>,
    layout: Option<&str>,
) -> Option<String> {
    let (Some(seed), Some(layout)) = (seed, layout) else {
        return None;
    };
    for path in list_replays(root) {
        let Ok(replay) = load_replay_md(&path) else {
            continue;
        };
        if replay.meta.base != Some(seed) || replay.meta.layout.as_deref() != Some(layout) {
            continue;
        }
        if let Some(link) = replay.meta.screenshot.clone() {
            // Ссылка живёт только если файл на месте.
            if screenshot_of(&path).is_some() {
                return Some(link);
            }
        }
    }
    None
}

/// Открыть картинку системным просмотрщиком. Процесс отвязан: консоль не ждёт.
pub(crate) fn open_image(path: &Path, viewer: &str) -> Result<(), String> {
    let viewer = viewer.trim();
    if viewer.is_empty() {
        return Err("не задан просмотрщик (replays.viewer)".into());
    }
    std::process::Command::new(viewer)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("не смог запустить {viewer}: {e}"))
}

/// Показать PNG реплея.
pub(crate) fn show_replay_image(replay_md: &Path, viewer: &str) {
    match screenshot_of(replay_md) {
        Some(png) => match open_image(&png, viewer) {
            Ok(()) => {
                println!("открыл скриншот: {}", png.display());
            }
            Err(message) => println!("{message}; файл: {}", png.display()),
        },
        None => {
            println!(
                "у {} нет скриншота (или файл рядом не найден)",
                replay_md
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("реплея")
            );
        }
    }
}

/// Все реплеи, сгруппированные по скелету и раскладке. Текущая база (если
/// известна) помечается: видно и «тот же скелет», и «та же раскладка».
///
/// `all = false` — только текущий скелет (тот, что загружен на экране): именно
/// его ищет игрок. Если под него ничего нет, печатается явное сообщение, а не
/// чужие записи. `all = true` или неизвестный текущий скелет — вся коллекция.
pub(crate) fn format_replays(root: &Path, current: Option<(i64, String)>, all: bool) -> Vec<String> {
    let mut groups: BTreeMap<i64, BTreeMap<String, Vec<ReplayVariant>>> = BTreeMap::new();
    let mut broken: Vec<(String, String)> = Vec::new();
    for path in list_replays(root) {
        let peek = match peek_replay_result(&path) {
            Ok(peek) => peek,
            Err(reason) => {
                // Ошибка загрузчика уже содержит путь, а имя файла печатается
                // отдельно — оставляем только причину.
                let reason = reason
                    .split_once(": ")
                    .filter(|(head, _)| head.starts_with("replay "))
                    .map(|(_, tail)| tail.to_string())
                    .unwrap_or(reason);
                broken.push((
                    path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                        .to_string(),
                    reason,
                ));
                continue;
            }
        };
        let Some(seed) = peek.base else {
            continue;
        };
        let layout = peek
            .layout
            .clone()
            .unwrap_or_else(|| "без подписи".to_string());
        groups
            .entry(seed)
            .or_default()
            .entry(layout)
            .or_default()
            .push(ReplayVariant::from_peek(path, peek));
    }
    if groups.is_empty() && broken.is_empty() {
        return vec!["реплеев нет — сначала record".to_string()];
    }

    let runs: usize = groups
        .values()
        .flat_map(|layouts| layouts.values())
        .map(|variants| variants.len())
        .sum();
    let bases = groups.len();
    let collection = format!(
        "{runs} {} в {bases} {}",
        plural_ru(runs, "запись", "записи", "записей"),
        if bases == 1 { "базе" } else { "базах" }
    );

    let scope = if all {
        None
    } else {
        current.as_ref().map(|(seed, _)| *seed)
    };
    if let Some(seed) = scope {
        if !groups.contains_key(&seed) {
            return vec![
                format!("ПОД ВАШ СКЕЛЕТ ЕЩЁ НЕТ ЗАПИСЕЙ! (seed={seed})"),
                format!("  в коллекции {collection} других скелетов — показать всё: replays all"),
            ];
        }
    }

    let scoped_runs: usize = groups
        .iter()
        .filter(|(seed, _)| scope.is_none_or(|wanted| wanted == **seed))
        .flat_map(|(_, layouts)| layouts.values())
        .map(|variants| variants.len())
        .sum();
    let other_runs = runs.saturating_sub(scoped_runs);
    let mut out = match scope {
        Some(seed) => {
            let mut head = format!(
                "скелет seed={seed}: {scoped_runs} {}",
                plural_ru(scoped_runs, "запись", "записи", "записей")
            );
            if other_runs > 0 {
                head.push_str(&format!(" (в коллекции ещё {other_runs})"));
            }
            vec![head]
        }
        None => vec![format!("всего {collection}")],
    };
    if scope.is_none() && current.is_none() && !all {
        out.push("  уровень не загружен — показываю все записи".to_string());
    }
    for (seed, layouts) in groups {
        if scope.is_some_and(|wanted| wanted != seed) {
            continue;
        }
        out.push(String::new());
        let same_seed = matches!(&current, Some((value, _)) if *value == seed);
        out.push(format!(
            "seed {seed}: {} {}{}",
            layouts.len(),
            plural_ru(layouts.len(), "раскладка", "раскладки", "раскладок"),
            if same_seed { "   <- текущий скелет" } else { "" }
        ));
        for (layout, mut variants) in layouts {
            variants.sort_by(|a, b| {
                a.variant
                    .unwrap_or(0)
                    .cmp(&b.variant.unwrap_or(0))
                    .then_with(|| a.path.cmp(&b.path))
            });
            let same_layout = matches!(&current, Some((value, fp)) if *value == seed && *fp == layout);
            out.push(format!(
                "  раскладка {layout}{}",
                if same_layout { "   <- на экране сейчас" } else { "" }
            ));
            for (i, variant) in variants.iter().enumerate() {
                out.push(format!("    {}", variant.line(i + 1)));
            }
        }
    }
    if !broken.is_empty() {
        out.push(String::new());
        out.push(format!("не читаются ({}): удалите или запишите заново", broken.len()));
        for (name, reason) in broken.iter().take(8) {
            out.push(format!("  {name} — {reason}"));
        }
    }
    out
}



#[cfg(test)]
mod plural_tests {
    use super::*;

    #[test]
    fn variants_word_follows_the_number() {
        assert_eq!(variants_label(1), "1 запись");
        assert_eq!(variants_label(2), "2 варианта");
        assert_eq!(variants_label(4), "4 варианта");
        assert_eq!(variants_label(5), "5 вариантов");
        assert_eq!(variants_label(11), "11 вариантов");
        assert_eq!(variants_label(12), "12 вариантов");
        assert_eq!(variants_label(21), "21 запись");
        assert_eq!(jumps_label(1), "1 прыжок");
        assert_eq!(jumps_label(2), "2 прыжка");
        assert_eq!(jumps_label(5), "5 прыжков");
        assert_eq!(jumps_label(13), "13 прыжков");
    }
}

#[cfg(test)]
mod plan_label_tests {
    use super::*;

    fn variant(jumps: usize, ms_steps: usize) -> ReplayVariant {
        ReplayVariant {
            path: PathBuf::from("20260101-000001(1).md"),
            variant: Some(1),
            jumps,
            ms_steps,
            has_state: false,
        }
    }

    /// План по времени не должен выглядеть как «0 прыжков».
    #[test]
    fn plan_label_distinguishes_time_based_steps() {
        assert_eq!(variant(5, 0).plan_label(), "5 прыжков");
        assert_eq!(variant(1, 0).plan_label(), "1 прыжок");
        assert_eq!(variant(0, 1).plan_label(), "1 шаг по времени");
        assert_eq!(variant(0, 3).plan_label(), "3 шага по времени");
        assert_eq!(variant(0, 7).plan_label(), "7 шагов по времени");
    }
}

#[cfg(test)]
mod watch_tests {
    use super::*;

    fn write_replay(root: &Path, base: i64, layout: &str, variant: Option<u32>) -> PathBuf {
        let dir = root.join(base.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        // Имя уникально для пары (раскладка, вариант): иначе запись с другой
        // раскладкой того же номера затирала бы файл.
        let path = match variant {
            Some(n) => dir.join(format!("{layout}-({n}).md")),
            None => dir.join(format!("{layout}-legacy.md")),
        };
        let replay = Replay {
            meta: Meta {
                schema: SCHEMA,
                base: Some(base),
                layout: Some(layout.to_string()),
                variant,
                anchor: Some("first_hero_update@1".into()),
                jumps: 1,
                ..Default::default()
            },
            anchor_frame: Some(1),
            anchor_kind: Some("first_hero_update".into()),
            events: vec![
                ReplayEvent { frame: 1, name: "first_hero_update".into() },
                ReplayEvent { frame: 31, name: "jump".into() },
            ],
            ..Default::default()
        };
        save_replay_md(&path, &replay).unwrap();
        path
    }

    #[test]
    fn exact_match_needs_both_skeleton_and_layout() {
        let root = std::env::temp_dir().join(format!("kot_tas_watch_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_replay(&root, 199_477_120, "16f12745", None);

        match find_replay_for(&root, Some(199_477_120), Some("16f12745")) {
            ReplayMatch::Exact(variants) => assert_eq!(variants.len(), 1),
            other => panic!("ожидалось точное совпадение, получено {other:?}"),
        }
        match find_replay_for(&root, Some(199_477_120), Some("deadbeef")) {
            ReplayMatch::SkeletonOnly { count, newest } => {
                assert_eq!(count, 1);
                assert!(newest.exists(), "подсказка должна показывать реальный файл");
            }
            other => panic!("ожидался тот же скелет, получено {other:?}"),
        }
        assert_eq!(
            find_replay_for(&root, Some(42), Some("16f12745")),
            ReplayMatch::None
        );
        assert_eq!(find_replay_for(&root, None, Some("16f12745")), ReplayMatch::None);
        assert_eq!(find_replay_for(&root, Some(199_477_120), None), ReplayMatch::None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Один и тот же уровень пройден по-разному: все варианты должны попасть в
    /// предложение, по порядку номеров, и следующий номер не должен повторяться.
    #[test]
    fn several_variants_are_listed_and_numbered() {
        let root = std::env::temp_dir().join(format!("kot_tas_variants_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_replay(&root, 17_794_082, "394ec424", Some(1));
        write_replay(&root, 17_794_082, "394ec424", Some(2));
        write_replay(&root, 17_794_082, "394ec424", None); // старый файл без номера
        write_replay(&root, 17_794_082, "deadbeef", Some(1)); // другая раскладка

        let ReplayMatch::Exact(variants) =
            find_replay_for(&root, Some(17_794_082), Some("394ec424"))
        else {
            panic!("ожидались варианты");
        };
        assert_eq!(variants.len(), 3);
        assert_eq!(variants[0].variant, None, "файл без номера идёт первым");
        assert_eq!(variants[1].variant, Some(1));
        assert_eq!(variants[2].variant, Some(2));

        let dir = root.join(17_794_082i64.to_string());
        let next = next_variant(
            &root,
            Some(17_794_082),
            Some("394ec424"),
            &dir,
            "20260101-010101",
        );
        assert_eq!(next, 3, "номер продолжается, а не начинается заново");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn play_argument_resolves_path_name_and_last() {
        let root = std::env::temp_dir().join(format!("kot_tas_args_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let path = write_replay(&root, 199_477_120, "16f12745", Some(1));
        let name = path.file_name().unwrap().to_str().unwrap().to_string();

        let by_path = resolve_replay_arg(&root, &path.display().to_string()).unwrap();
        assert_eq!(by_path, path);
        let by_name = resolve_replay_arg(&root, &name.to_ascii_uppercase()).unwrap();
        assert_eq!(by_name, path, "имя файла ищется без учёта регистра");
        assert_eq!(resolve_replay_arg(&root, "last").unwrap(), path);
        let missing = resolve_replay_arg(&root, "нет-такого.md").unwrap_err();
        assert!(missing.contains("не найден"), "{missing}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Аргумент не указан: точная подпись, иначе тот же скелет, иначе самый свежий.
    #[test]
    fn auto_pick_prefers_exact_then_same_skeleton() {
        let root = std::env::temp_dir().join(format!("kot_tas_pick_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let other = write_replay(&root, 199_477_120, "deadbeef", Some(1));
        let exact = write_replay(&root, 199_477_120, "16f12745", Some(2));

        let (path, why) = pick_by_layout(&root, Some(199_477_120), Some("16f12745")).unwrap();
        assert_eq!(path, exact);
        assert!(why.contains("совпала подпись"), "{why}");

        let (path, why) = pick_by_layout(&root, Some(199_477_120), Some("ffffffff")).unwrap();
        assert!(path == exact || path == other, "{path:?}");
        assert!(why.contains("скелет"), "{why}");

        let (_, why) = pick_by_layout(&root, Some(42), Some("ffffffff")).unwrap();
        assert!(why.contains("самый свежий"), "{why}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `replays` показывает всё, что записано: скелет, раскладки, варианты, и
    /// помечает ту базу, что сейчас на экране.
    #[test]
    fn replays_listing_groups_by_skeleton_and_marks_current() {
        let root = std::env::temp_dir().join(format!("kot_tas_list_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_replay(&root, 142_614_553, "dfc00cec", Some(1));
        write_replay(&root, 142_614_553, "1d539025", Some(1));
        write_replay(&root, 17_794_082, "394ec424", Some(1));

        // без "all" — только текущий скелет
        let lines = format_replays(&root, Some((142_614_553, "1d539025".into())), false);
        let text = lines.join(chr_n());
        assert!(text.contains("скелет seed=142614553"), "{text}");
        assert!(text.contains("раскладка 1d539025   <- на экране сейчас"), "{text}");
        assert!(!text.contains("seed 17794082"), "чужие скелеты не показываем: {text}");

        // под текущий скелет записей нет — явное сообщение вместо чужих
        let missing = format_replays(&root, Some((1032192, "2a9ab8b2".into())), false);
        let text = missing.join(chr_n());
        assert!(text.contains("ПОД ВАШ СКЕЛЕТ ЕЩЁ НЕТ ЗАПИСЕЙ!"), "{text}");
        assert!(!text.contains("раскладка 394ec424"), "{text}");

        // "all" — вся коллекция
        let everything = format_replays(&root, Some((142_614_553, "1d539025".into())), true);
        let text = everything.join(chr_n());
        assert!(text.contains("всего 3 записи в 2 базах"), "{text}");
        assert!(text.contains("seed 17794082: 1 раскладка"), "{text}");
        assert!(text.contains("seed 142614553: 2 раскладки"), "{text}");

        let empty = format_replays(&root.join("nope"), None, false);
        assert_eq!(empty, vec!["реплеев нет — сначала record".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn chr_n() -> &'static str {
        "\n"
    }
}

#[cfg(test)]
mod nostate_tests {
    use super::*;

    /// Файл, из которого руками убрали блок `state`, должен остаться играбельным
    /// по резервному плану — и предложение обязано это показывать.
    #[test]
    fn frames_only_variant_is_flagged_in_the_list() {
        let root = std::env::temp_dir().join(format!("kot_tas_nostate_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("199477120");
        std::fs::create_dir_all(&dir).unwrap();
        let text = r#"
```yaml
schema: 1
base: 199477120
layout: 16f12745
variant: 1
anchor: first_hero_update@1
jumps: 2
```

```frames
delta: true
+20
+30
```
"#;
        std::fs::write(dir.join("20260101-000001(1).md"), text).unwrap();

        let ReplayMatch::Exact(variants) =
            find_replay_for(&root, Some(199_477_120), Some("16f12745"))
        else {
            panic!("ожидался вариант");
        };
        assert_eq!(variants.len(), 1);
        assert!(!variants[0].has_state, "файл без state должен быть помечен");
        assert_eq!(variants[0].jumps, 2);

        let replay = load_replay_md(&dir.join("20260101-000001(1).md")).unwrap();
        assert!(!replay.has_state);
        assert!(replay.body_frames.is_empty());
        assert_eq!(replay.events.len(), 3, "якорь + 2 прыжка");
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod image_tests {
    use super::*;

    /// Ссылка в шапке относительная (`../images/…`): проверяем, что она
    /// разрешается от каталога реплея, а не от текущего каталога процесса.
    #[test]
    fn screenshot_path_resolves_next_to_replay() {
        let root = std::env::temp_dir().join(format!("kot_tas_img_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let base_dir = root.join("1032192");
        let images = root.join("images");
        std::fs::create_dir_all(&base_dir).unwrap();
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(images.join("20260101-000001(1).png"), b"\x89PNG\r\n\x1a\n").unwrap();

        let md = base_dir.join("20260101-000001(1).md");
        let replay = Replay {
            meta: Meta {
                schema: SCHEMA,
                base: Some(1_032_192),
                variant: Some(1),
                anchor: Some("first_hero_update@1".into()),
                jumps: 1,
                screenshot: Some("../images/20260101-000001(1).png".into()),
                ..Default::default()
            },
            anchor_frame: Some(1),
            anchor_kind: Some("first_hero_update".into()),
            events: vec![
                ReplayEvent { frame: 1, name: "first_hero_update".into() },
                ReplayEvent { frame: 31, name: "jump".into() },
            ],
            ..Default::default()
        };
        save_replay_md(&md, &replay).unwrap();

        let found = screenshot_of(&md).expect("картинка должна найтись по ссылке из шапки");
        let expected = std::fs::canonicalize(images.join("20260101-000001(1).png")).unwrap();
        assert_eq!(found, expected);

        std::fs::remove_file(images.join("20260101-000001(1).png")).unwrap();
        assert!(screenshot_of(&md).is_none(), "пропавший файл — не находка");
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod shot_tests {
    use super::*;
    use crate::replay::{save_replay_md, Meta, Replay, ReplayEvent, SCHEMA};

    fn write(root: &Path, base: i64, layout: &str, variant: u32, link: Option<&str>) -> PathBuf {
        let dir = root.join(base.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("20260101-00000{variant}({variant}).md"));
        let replay = Replay {
            meta: Meta {
                schema: SCHEMA,
                base: Some(base),
                layout: Some(layout.to_string()),
                variant: Some(variant),
                anchor: Some("first_hero_update@1".into()),
                jumps: 1,
                screenshot: link.map(|value| value.to_string()),
                ..Default::default()
            },
            anchor_frame: Some(1),
            anchor_kind: Some("first_hero_update".into()),
            events: vec![
                ReplayEvent { frame: 1, name: "first_hero_update".into() },
                ReplayEvent { frame: 31, name: "jump".into() },
            ],
            ..Default::default()
        };
        save_replay_md(&path, &replay).unwrap();
        path
    }

    /// Второй вариант того же уровня — то же подземелье: кадр берём готовый.
    #[test]
    fn screenshot_is_reused_for_the_same_skeleton_and_layout() {
        let root = std::env::temp_dir().join(format!("kot_tas_shot_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let images = root.join("images");
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(images.join("a.png"), b"png").unwrap();
        write(&root, 17_794_082, "394ec424", 1, Some("../images/a.png"));

        assert_eq!(
            existing_screenshot(&root, Some(17_794_082), Some("394ec424")).as_deref(),
            Some("../images/a.png")
        );
        assert!(
            existing_screenshot(&root, Some(17_794_082), Some("deadbeef")).is_none(),
            "другая раскладка — другой кадр"
        );
        std::fs::remove_file(images.join("a.png")).unwrap();
        assert!(
            existing_screenshot(&root, Some(17_794_082), Some("394ec424")).is_none(),
            "мёртвая ссылка не переиспользуется"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
