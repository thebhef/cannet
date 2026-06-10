//! Named CRC algorithm catalogue for calculated fields (ADR 0027).
//!
//! The name list is `crc-catalog`'s, verbatim — zero curation. One entry
//! is omitted: `CRC-82/DARC`, whose width exceeds the 64 bits a DBC
//! signal can carry. Parameters are widened to `Algorithm<u64>` once so
//! a single `Crc<u64>` engine serves every width; the widening is
//! verified against the catalogue check values by the tests in
//! [`crate::calc`].
//!
//! The pair list below is derived mechanically from `crc-catalog`
//! 2.5.0's constant list (name from each constant's doc header).
//! Regenerate it when that crate is bumped.

use std::sync::OnceLock;

use crc::Algorithm;

/// Widen a catalogue entry of any register width to `Algorithm<u64>`.
/// The computation is width-agnostic — the `width` field, not the
/// register type, drives the maths — so a widened entry produces the
/// same checksums as the original.
fn widen<W>(a: &Algorithm<W>) -> Algorithm<u64>
where
    W: crc::Width + Copy + Into<u64>,
{
    Algorithm {
        width: a.width,
        poly: a.poly.into(),
        init: a.init.into(),
        refin: a.refin,
        refout: a.refout,
        xorout: a.xorout.into(),
        check: a.check.into(),
        residue: a.residue.into(),
    }
}

static TABLE: OnceLock<Vec<(&'static str, Algorithm<u64>)>> = OnceLock::new();

/// Every named algorithm, as `(catalogue name, widened parameters)`,
/// in the catalogue's order.
// One generated line per catalogue entry — splitting the list would
// only obscure its mechanical provenance.
#[allow(clippy::too_many_lines)]
pub(crate) fn named_algorithms() -> &'static [(&'static str, Algorithm<u64>)] {
    TABLE
        .get_or_init(|| {
            vec![
                ("CRC-3/GSM", widen(&crc::CRC_3_GSM)),
                ("CRC-3/ROHC", widen(&crc::CRC_3_ROHC)),
                ("CRC-4/G-704", widen(&crc::CRC_4_G_704)),
                ("CRC-4/INTERLAKEN", widen(&crc::CRC_4_INTERLAKEN)),
                ("CRC-5/EPC-C1G2", widen(&crc::CRC_5_EPC_C1G2)),
                ("CRC-5/G-704", widen(&crc::CRC_5_G_704)),
                ("CRC-5/USB", widen(&crc::CRC_5_USB)),
                ("CRC-6/CDMA2000-A", widen(&crc::CRC_6_CDMA2000_A)),
                ("CRC-6/CDMA2000-B", widen(&crc::CRC_6_CDMA2000_B)),
                ("CRC-6/DARC", widen(&crc::CRC_6_DARC)),
                ("CRC-6/G-704", widen(&crc::CRC_6_G_704)),
                ("CRC-6/GSM", widen(&crc::CRC_6_GSM)),
                ("CRC-7/MMC", widen(&crc::CRC_7_MMC)),
                ("CRC-7/ROHC", widen(&crc::CRC_7_ROHC)),
                ("CRC-7/UMTS", widen(&crc::CRC_7_UMTS)),
                ("CRC-8/AUTOSAR", widen(&crc::CRC_8_AUTOSAR)),
                ("CRC-8/BLUETOOTH", widen(&crc::CRC_8_BLUETOOTH)),
                ("CRC-8/CDMA2000", widen(&crc::CRC_8_CDMA2000)),
                ("CRC-8/DARC", widen(&crc::CRC_8_DARC)),
                ("CRC-8/DVB-S2", widen(&crc::CRC_8_DVB_S2)),
                ("CRC-8/GSM-A", widen(&crc::CRC_8_GSM_A)),
                ("CRC-8/GSM-B", widen(&crc::CRC_8_GSM_B)),
                ("CRC-8/HITAG", widen(&crc::CRC_8_HITAG)),
                ("CRC-8/I-432-1", widen(&crc::CRC_8_I_432_1)),
                ("CRC-8/I-CODE", widen(&crc::CRC_8_I_CODE)),
                ("CRC-8/LTE", widen(&crc::CRC_8_LTE)),
                ("CRC-8/MAXIM-DOW", widen(&crc::CRC_8_MAXIM_DOW)),
                ("CRC-8/MIFARE-MAD", widen(&crc::CRC_8_MIFARE_MAD)),
                ("CRC-8/NRSC-5", widen(&crc::CRC_8_NRSC_5)),
                ("CRC-8/OPENSAFETY", widen(&crc::CRC_8_OPENSAFETY)),
                ("CRC-8/ROHC", widen(&crc::CRC_8_ROHC)),
                ("CRC-8/SAE-J1850", widen(&crc::CRC_8_SAE_J1850)),
                ("CRC-8/SMBUS", widen(&crc::CRC_8_SMBUS)),
                ("CRC-8/TECH-3250", widen(&crc::CRC_8_TECH_3250)),
                ("CRC-8/WCDMA", widen(&crc::CRC_8_WCDMA)),
                ("CRC-10/ATM", widen(&crc::CRC_10_ATM)),
                ("CRC-10/CDMA2000", widen(&crc::CRC_10_CDMA2000)),
                ("CRC-10/GSM", widen(&crc::CRC_10_GSM)),
                ("CRC-11/FLEXRAY", widen(&crc::CRC_11_FLEXRAY)),
                ("CRC-11/UMTS", widen(&crc::CRC_11_UMTS)),
                ("CRC-12/CDMA2000", widen(&crc::CRC_12_CDMA2000)),
                ("CRC-12/DECT", widen(&crc::CRC_12_DECT)),
                ("CRC-12/GSM", widen(&crc::CRC_12_GSM)),
                ("CRC-12/UMTS", widen(&crc::CRC_12_UMTS)),
                ("CRC-13/BBC", widen(&crc::CRC_13_BBC)),
                ("CRC-14/DARC", widen(&crc::CRC_14_DARC)),
                ("CRC-14/GSM", widen(&crc::CRC_14_GSM)),
                ("CRC-15/CAN", widen(&crc::CRC_15_CAN)),
                ("CRC-15/MPT1327", widen(&crc::CRC_15_MPT1327)),
                ("CRC-16/ARC", widen(&crc::CRC_16_ARC)),
                ("CRC-16/CDMA2000", widen(&crc::CRC_16_CDMA2000)),
                ("CRC-16/CMS", widen(&crc::CRC_16_CMS)),
                ("CRC-16/DDS-110", widen(&crc::CRC_16_DDS_110)),
                ("CRC-16/DECT-R", widen(&crc::CRC_16_DECT_R)),
                ("CRC-16/DECT-X", widen(&crc::CRC_16_DECT_X)),
                ("CRC-16/DNP", widen(&crc::CRC_16_DNP)),
                ("CRC-16/EN-13757", widen(&crc::CRC_16_EN_13757)),
                ("CRC-16/GENIBUS", widen(&crc::CRC_16_GENIBUS)),
                ("CRC-16/GSM", widen(&crc::CRC_16_GSM)),
                ("CRC-16/IBM-3740", widen(&crc::CRC_16_IBM_3740)),
                ("CRC-16/IBM-SDLC", widen(&crc::CRC_16_IBM_SDLC)),
                ("CRC-16/ISO-IEC-14443-3-A", widen(&crc::CRC_16_ISO_IEC_14443_3_A)),
                ("CRC-16/KERMIT", widen(&crc::CRC_16_KERMIT)),
                ("CRC-16/LJ1200", widen(&crc::CRC_16_LJ1200)),
                ("CRC-16/M17", widen(&crc::CRC_16_M17)),
                ("CRC-16/MAXIM-DOW", widen(&crc::CRC_16_MAXIM_DOW)),
                ("CRC-16/MCRF4XX", widen(&crc::CRC_16_MCRF4XX)),
                ("CRC-16/MODBUS", widen(&crc::CRC_16_MODBUS)),
                ("CRC-16/NRSC-5", widen(&crc::CRC_16_NRSC_5)),
                ("CRC-16/OPENSAFETY-A", widen(&crc::CRC_16_OPENSAFETY_A)),
                ("CRC-16/OPENSAFETY-B", widen(&crc::CRC_16_OPENSAFETY_B)),
                ("CRC-16/PROFIBUS", widen(&crc::CRC_16_PROFIBUS)),
                ("CRC-16/RIELLO", widen(&crc::CRC_16_RIELLO)),
                ("CRC-16/SPI-FUJITSU", widen(&crc::CRC_16_SPI_FUJITSU)),
                ("CRC-16/T10-DIF", widen(&crc::CRC_16_T10_DIF)),
                ("CRC-16/TELEDISK", widen(&crc::CRC_16_TELEDISK)),
                ("CRC-16/TMS37157", widen(&crc::CRC_16_TMS37157)),
                ("CRC-16/UMTS", widen(&crc::CRC_16_UMTS)),
                ("CRC-16/USB", widen(&crc::CRC_16_USB)),
                ("CRC-16/XMODEM", widen(&crc::CRC_16_XMODEM)),
                ("CRC-17/CAN-FD", widen(&crc::CRC_17_CAN_FD)),
                ("CRC-21/CAN-FD", widen(&crc::CRC_21_CAN_FD)),
                ("CRC-24/BLE", widen(&crc::CRC_24_BLE)),
                ("CRC-24/FLEXRAY-A", widen(&crc::CRC_24_FLEXRAY_A)),
                ("CRC-24/FLEXRAY-B", widen(&crc::CRC_24_FLEXRAY_B)),
                ("CRC-24/INTERLAKEN", widen(&crc::CRC_24_INTERLAKEN)),
                ("CRC-24/LTE-A", widen(&crc::CRC_24_LTE_A)),
                ("CRC-24/LTE-B", widen(&crc::CRC_24_LTE_B)),
                ("CRC-24/OPENPGP", widen(&crc::CRC_24_OPENPGP)),
                ("CRC-24/OS-9", widen(&crc::CRC_24_OS_9)),
                ("CRC-30/CDMA", widen(&crc::CRC_30_CDMA)),
                ("CRC-31/PHILIPS", widen(&crc::CRC_31_PHILIPS)),
                ("CRC-32/AIXM", widen(&crc::CRC_32_AIXM)),
                ("CRC-32/AUTOSAR", widen(&crc::CRC_32_AUTOSAR)),
                ("CRC-32/BASE91-D", widen(&crc::CRC_32_BASE91_D)),
                ("CRC-32/BZIP2", widen(&crc::CRC_32_BZIP2)),
                ("CRC-32/CD-ROM-EDC", widen(&crc::CRC_32_CD_ROM_EDC)),
                ("CRC-32/CKSUM", widen(&crc::CRC_32_CKSUM)),
                ("CRC-32/ISCSI", widen(&crc::CRC_32_ISCSI)),
                ("CRC-32/ISO-HDLC", widen(&crc::CRC_32_ISO_HDLC)),
                ("CRC-32/JAMCRC", widen(&crc::CRC_32_JAMCRC)),
                ("CRC-32/MEF", widen(&crc::CRC_32_MEF)),
                ("CRC-32/MPEG-2", widen(&crc::CRC_32_MPEG_2)),
                ("CRC-32/XFER", widen(&crc::CRC_32_XFER)),
                ("CRC-40/GSM", widen(&crc::CRC_40_GSM)),
                ("CRC-64/ECMA-182", widen(&crc::CRC_64_ECMA_182)),
                ("CRC-64/GO-ISO", widen(&crc::CRC_64_GO_ISO)),
                ("CRC-64/MS", widen(&crc::CRC_64_MS)),
                ("CRC-64/NVME", widen(&crc::CRC_64_NVME)),
                ("CRC-64/REDIS", widen(&crc::CRC_64_REDIS)),
                ("CRC-64/WE", widen(&crc::CRC_64_WE)),
                ("CRC-64/XZ", widen(&crc::CRC_64_XZ)),
            ]
        })
        .as_slice()
}

/// Look up a catalogue name (e.g. `CRC-8/SAE-J1850`). Exact match.
pub(crate) fn lookup(name: &str) -> Option<&'static Algorithm<u64>> {
    named_algorithms()
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, a)| a)
}
