use anyhow::{bail, Result};

use crate::canonical::LogisticFilterEntry;

pub struct ByteReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    #[allow(dead_code)]
    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    pub fn read_u8(&mut self) -> Result<u8> {
        if self.pos + 1 > self.buf.len() {
            bail!("unexpected EOF reading u8");
        }
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }

    pub fn read_u16(&mut self) -> Result<u16> {
        if self.pos + 2 > self.buf.len() {
            bail!("unexpected EOF reading u16");
        }
        let v = u16::from_le_bytes([self.buf[self.pos], self.buf[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }

    pub fn read_i32(&mut self) -> Result<i32> {
        if self.pos + 4 > self.buf.len() {
            bail!("unexpected EOF reading i32");
        }
        let v = i32::from_le_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    pub fn read_u32(&mut self) -> Result<u32> {
        Ok(self.read_i32()? as u32)
    }

    pub fn read_fstring(&mut self) -> Result<String> {
        let len = self.read_i32()?;
        if len == 0 {
            return Ok(String::new());
        }
        if len > 0 {
            let n = len as usize;
            if self.pos + n > self.buf.len() {
                bail!("unexpected EOF reading ASCII FString of len {n}");
            }
            let slice = &self.buf[self.pos..self.pos + n];
            self.pos += n;
            let trimmed = slice.strip_suffix(&[0]).unwrap_or(slice);
            Ok(String::from_utf8_lossy(trimmed).into_owned())
        } else {
            let count = (-len) as usize;
            let byte_len = count.checked_mul(2).ok_or_else(|| anyhow::anyhow!("overflow"))?;
            if self.pos + byte_len > self.buf.len() {
                bail!("unexpected EOF reading UTF-16 FString of {count} chars");
            }
            let mut units = Vec::with_capacity(count);
            for i in 0..count {
                let off = self.pos + i * 2;
                units.push(u16::from_le_bytes([self.buf[off], self.buf[off + 1]]));
            }
            self.pos += byte_len;
            if units.last() == Some(&0) {
                units.pop();
            }
            Ok(String::from_utf16_lossy(&units))
        }
    }

    pub fn read_u8_array(&mut self) -> Result<Vec<u8>> {
        let len = self.read_i32()?;
        if len < 0 {
            bail!("negative TArray<u8> length {len}");
        }
        let n = len as usize;
        if self.pos + n > self.buf.len() {
            bail!("unexpected EOF reading TArray<u8> of len {n}");
        }
        let out = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Ok(out)
    }

    /// Reads UE `FText` serialized via `FArchive << FText` (handles None / CultureInvariant).
    pub fn read_ftext_simple(&mut self) -> Result<Option<String>> {
        let _flags = self.read_u32()?;
        let history_type = self.read_u8()? as i8;
        if history_type == -1 {
            let has_str = self.read_i32()?;
            if has_str != 0 {
                Ok(Some(self.read_fstring()?))
            } else {
                Ok(None)
            }
        } else if history_type == 0 {
            // Base: Namespace, Key, SourceString
            let _ns = self.read_fstring()?;
            let _key = self.read_fstring()?;
            Ok(Some(self.read_fstring()?))
        } else {
            Ok(None)
        }
    }
}

pub struct ByteWriter {
    pub buf: Vec<u8>,
}

impl ByteWriter {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn write_u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    pub fn write_u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn write_i32(&mut self, v: i32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn write_u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn write_fstring(&mut self, s: &str) {
        if s.is_empty() {
            self.write_i32(0);
            return;
        }
        if s.is_ascii() {
            let bytes = s.as_bytes();
            self.write_i32((bytes.len() + 1) as i32);
            self.buf.extend_from_slice(bytes);
            self.buf.push(0);
        } else {
            let units: Vec<u16> = s.encode_utf16().collect();
            self.write_i32(-((units.len() + 1) as i32));
            for u in units {
                self.buf.extend_from_slice(&u.to_le_bytes());
            }
            self.buf.extend_from_slice(&0u16.to_le_bytes());
        }
    }

    pub fn write_u8_array(&mut self, arr: &[u8]) {
        self.write_i32(arr.len() as i32);
        self.buf.extend_from_slice(arr);
    }

    pub fn write_ftext_culture_invariant(&mut self, s: Option<&str>) {
        self.write_u32(0); // flags
        self.write_u8(255); // ETextHistoryType::None (-1)
        match s {
            Some(text) if !text.is_empty() => {
                self.write_i32(1);
                self.write_fstring(text);
            }
            _ => {
                self.write_i32(0);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct AssemblerConfig {
    pub recipe_native: String,
    pub port_states: Vec<u8>,
}

pub fn decode_assembler_config(bytes: &[u8]) -> Result<AssemblerConfig> {
    if bytes.is_empty() {
        return Ok(AssemblerConfig {
            recipe_native: String::new(),
            port_states: Vec::new(),
        });
    }
    let mut r = ByteReader::new(bytes);
    let _ver = r.read_u16()?;
    let recipe_native = r.read_fstring()?;
    let port_states = r.read_u8_array()?;
    Ok(AssemblerConfig {
        recipe_native,
        port_states,
    })
}

pub fn encode_assembler_config(cfg: &AssemblerConfig) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_u16(1);
    w.write_fstring(&cfg.recipe_native);
    w.write_u8_array(&cfg.port_states);
    w.buf
}

#[derive(Debug, Clone)]
pub struct ContainerConfig {
    pub b_creative: bool,
    pub creative_item_native: String,
    pub b_creative_consume: bool,
    pub logistic_filters: Vec<LogisticFilterEntry>,
    pub port_states: Vec<u8>,
}

pub fn decode_container_config(
    bytes: &[u8],
    item_to_canonical: impl Fn(&str) -> String,
) -> Result<ContainerConfig> {
    if bytes.is_empty() {
        return Ok(ContainerConfig {
            b_creative: false,
            creative_item_native: String::new(),
            b_creative_consume: false,
            logistic_filters: Vec::new(),
            port_states: Vec::new(),
        });
    }
    let mut r = ByteReader::new(bytes);
    let _ver = r.read_u16()?;
    let b_creative = r.read_u32()? != 0;
    let creative_item_native = r.read_fstring()?;
    let b_creative_consume = r.read_u32()? != 0;
    let filter_count = r.read_i32()?;
    if filter_count < 0 {
        bail!("negative LogisticFilters count {filter_count}");
    }
    let mut logistic_filters = Vec::with_capacity(filter_count as usize);
    for _ in 0..filter_count {
        let item_native = r.read_fstring()?;
        let amount = r.read_i32()?;
        let action = r.read_u8()?;
        logistic_filters.push(LogisticFilterEntry {
            item_id: item_to_canonical(&item_native),
            amount,
            action,
        });
    }
    let port_states = r.read_u8_array()?;
    Ok(ContainerConfig {
        b_creative,
        creative_item_native,
        b_creative_consume,
        logistic_filters,
        port_states,
    })
}

pub fn encode_container_config(
    cfg: &ContainerConfig,
    item_to_native: impl Fn(&str) -> String,
) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_u16(1);
    w.write_u32(if cfg.b_creative { 1 } else { 0 });
    w.write_fstring(&cfg.creative_item_native);
    w.write_u32(if cfg.b_creative_consume { 1 } else { 0 });
    w.write_i32(cfg.logistic_filters.len() as i32);
    for f in &cfg.logistic_filters {
        w.write_fstring(&item_to_native(&f.item_id));
        w.write_i32(f.amount);
        w.write_u8(f.action);
    }
    w.write_u8_array(&cfg.port_states);
    w.buf
}

#[derive(Debug, Clone)]
pub struct SplitterConfig {
    pub filters_native: Vec<String>,
    pub priority_output_index: i32,
    pub priority_input_index: i32,
    pub port_states: Vec<u8>,
}

pub fn decode_splitter_config(bytes: &[u8]) -> Result<SplitterConfig> {
    if bytes.is_empty() {
        return Ok(SplitterConfig {
            filters_native: Vec::new(),
            priority_output_index: -1,
            priority_input_index: -1,
            port_states: Vec::new(),
        });
    }
    let mut r = ByteReader::new(bytes);
    let _ver = r.read_u16()?;
    let filter_count = r.read_i32()?;
    if filter_count < 0 {
        bail!("negative Splitter Filters count {filter_count}");
    }
    let mut filters_native = Vec::with_capacity(filter_count as usize);
    for _ in 0..filter_count {
        filters_native.push(r.read_fstring()?);
    }
    // Verified from SplitterObject::SaveConfig disassembly (0x14430fbc6 / 0x14430fc1a):
    // PriorityOutputIndex (+0x1f8) is serialized BEFORE PriorityInputIndex (+0x1f4)!
    let priority_output_index = r.read_i32()?;
    let priority_input_index = r.read_i32()?;
    let port_states = r.read_u8_array()?;
    Ok(SplitterConfig {
        filters_native,
        priority_output_index,
        priority_input_index,
        port_states,
    })
}

pub fn encode_splitter_config(cfg: &SplitterConfig) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_u16(1);
    w.write_i32(cfg.filters_native.len() as i32);
    for f in &cfg.filters_native {
        w.write_fstring(f);
    }
    w.write_i32(cfg.priority_output_index);
    w.write_i32(cfg.priority_input_index);
    w.write_u8_array(&cfg.port_states);
    w.buf
}

pub fn decode_underground_length(bytes: &[u8]) -> Result<i32> {
    if bytes.is_empty() {
        return Ok(2);
    }
    let mut r = ByteReader::new(bytes);
    let _ver = r.read_u16()?;
    let length = r.read_i32()?;
    Ok(length.max(2))
}

pub fn encode_underground_length(length: i32) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_u16(1);
    w.write_i32(length.max(2));
    w.buf
}

pub fn decode_mining_drone_bay_item(bytes: &[u8]) -> Result<String> {
    if bytes.is_empty() {
        return Ok(String::new());
    }
    let mut r = ByteReader::new(bytes);
    let _ver = r.read_u16()?;
    r.read_fstring()
}

pub fn encode_mining_drone_bay_item(item_native: &str) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_u16(1);
    w.write_fstring(item_native);
    w.buf
}

pub fn decode_elevator_or_teleporter_label(bytes: &[u8]) -> Result<Option<String>> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let mut r = ByteReader::new(bytes);
    let _ver = r.read_u16()?;
    r.read_ftext_simple()
}

pub fn encode_elevator_or_teleporter_label(label: Option<&str>) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_u16(1);
    w.write_ftext_culture_invariant(label);
    w.buf
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockFilterEntry {
    pub item_native: String,
    pub b_loading: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockConfig {
    pub display_name: String,
    pub filters: Vec<DockFilterEntry>,
}

/// Verified from Dock::SaveConfig (0x1442d6670) & SerializeDockFilters (0x1443137f0):
/// u16 version(1) + FString DisplayName + i32 FilterCount + N * (FString ItemName + u32 bLoading).
pub fn decode_dock_config(bytes: &[u8]) -> Result<DockConfig> {
    if bytes.is_empty() {
        return Ok(DockConfig {
            display_name: String::new(),
            filters: Vec::new(),
        });
    }
    let mut r = ByteReader::new(bytes);
    let _ver = r.read_u16()?;
    let display_name = r.read_fstring()?;
    let count = r.read_i32()?;
    if count < 0 {
        bail!("negative Dock Filters count {count}");
    }
    let mut filters = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let item_native = r.read_fstring()?;
        let b_loading = r.read_u32()? != 0;
        filters.push(DockFilterEntry {
            item_native,
            b_loading,
        });
    }
    Ok(DockConfig {
        display_name,
        filters,
    })
}

pub fn encode_dock_config(cfg: &DockConfig) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.write_u16(1);
    w.write_fstring(&cfg.display_name);
    w.write_i32(cfg.filters.len() as i32);
    for f in &cfg.filters {
        w.write_fstring(&f.item_native);
        w.write_u32(if f.b_loading { 1 } else { 0 });
    }
    w.buf
}

pub fn decode_dock_name(bytes: &[u8]) -> Result<Option<String>> {
    let cfg = decode_dock_config(bytes)?;
    if cfg.display_name.is_empty() {
        Ok(None)
    } else {
        Ok(Some(cfg.display_name))
    }
}

pub fn encode_dock_config_simple(name: Option<&str>) -> Vec<u8> {
    encode_dock_config(&DockConfig {
        display_name: name.unwrap_or("").to_owned(),
        filters: Vec::new(),
    })
}
