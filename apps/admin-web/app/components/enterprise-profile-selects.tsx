"use client";

import { areaList } from "@vant/area-data";
import { useEffect, useRef, useState } from "react";

export type IndustryOption = Readonly<{
  id: string;
  name: string;
  sortOrder: number;
}>;

const provinces = Object.entries(areaList.province_list);
const cities = Object.entries(areaList.city_list);

export function IndustrySelect({
  disabled = false,
  id,
  industries,
  loading = false,
  onChange,
  value,
}: Readonly<{
  disabled?: boolean;
  id: string;
  industries: readonly IndustryOption[];
  loading?: boolean;
  onChange: (value: string) => void;
  value: string;
}>) {
  const currentIndustry = value.trim();
  const hasCurrentIndustry = industries.some(({ name }) => name === currentIndustry);

  return (
    <>
      <select
        aria-label="行业"
        disabled={disabled || loading}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">{loading ? "正在加载行业…" : "请选择行业"}</option>
        {!hasCurrentIndustry && currentIndustry ? (
          <option value={currentIndustry}>{currentIndustry}（当前值）</option>
        ) : null}
        {industries.map((industry) => (
          <option key={industry.id} value={industry.name}>
            {industry.name}
          </option>
        ))}
      </select>
      {!loading && industries.length === 0 ? (
        <small>暂未配置行业，可由系统管理员在行业管理中添加。</small>
      ) : null}
    </>
  );
}

export function ProvinceCitySelect({
  city,
  disabled = false,
  onCityChange,
  resetKey,
}: Readonly<{
  city: string;
  disabled?: boolean;
  onCityChange: (city: string) => void;
  resetKey: string;
}>) {
  const initial = citySelection(city);
  const [provinceCode, setProvinceCode] = useState(initial.provinceCode);
  const [cityCode, setCityCode] = useState(initial.cityCode);
  const previousResetKey = useRef(resetKey);

  useEffect(() => {
    const resetChanged = previousResetKey.current !== resetKey;
    previousResetKey.current = resetKey;
    if (!city) {
      if (resetChanged) {
        setProvinceCode("");
        setCityCode("");
      }
      return;
    }
    const next = citySelection(city);
    setProvinceCode(next.provinceCode);
    setCityCode(next.cityCode);
  }, [city, resetKey]);

  const cityOptions = provinceCode
    ? cities.filter(([code]) => code.slice(0, 2) === provinceCode.slice(0, 2))
    : [];
  const currentCityIsLegacy = cityCode.startsWith("legacy:");

  return (
    <>
      <label className="field">
        <span>省 / 自治区</span>
        <select
          aria-label="省或自治区"
          disabled={disabled}
          onChange={(event) => {
            setProvinceCode(event.target.value);
            setCityCode("");
            onCityChange("");
          }}
          value={provinceCode}
        >
          <option value="">请选择省 / 自治区</option>
          {provinces.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>城市</span>
        <select
          aria-label="城市"
          disabled={disabled || !provinceCode}
          onChange={(event) => {
            const nextCity = event.target.value;
            setCityCode(nextCity);
            onCityChange(cityName(nextCity));
          }}
          value={cityCode}
        >
          <option value="">请选择城市</option>
          {currentCityIsLegacy ? <option value={cityCode}>{city}（当前值）</option> : null}
          {cityOptions.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function citySelection(value: string): Readonly<{ cityCode: string; provinceCode: string }> {
  const cityCode = cities.find(([, name]) => samePlace(name, value))?.[0];
  if (!cityCode) return { cityCode: value ? `legacy:${value}` : "", provinceCode: "" };
  return { cityCode, provinceCode: `${cityCode.slice(0, 2)}0000` };
}

function cityName(code: string): string {
  return cities.find(([cityCode]) => cityCode === code)?.[1] ?? "";
}

function samePlace(left: string, right: string): boolean {
  return normalizePlace(left) === normalizePlace(right);
}

function normalizePlace(value: string): string {
  return value.trim().replace(/(?:市|地区|自治州|盟)$/u, "");
}
