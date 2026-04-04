import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { 
  Save, 
  User, 
  Bell, 
  Palette, 
  Settings2, 
  Link2, 
  Users, 
  Shield,
  Mail,
  Building,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  Upload,
  X,
  Image
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { BrandingSettings } from "@shared/schema";

function ColorInput({ label, value, onChange, testId }: { label: string; value: string; onChange: (v: string) => void; testId: string }) {
  const isValidHsl = (hsl: string) => {
    if (!hsl || typeof hsl !== 'string') return false;
    const parts = hsl.trim().split(/\s+/);
    if (parts.length !== 3) return false;
    const [h, s, l] = parts.map(v => parseFloat(v.replace('%', '')));
    return !isNaN(h) && !isNaN(s) && !isNaN(l) && 
           h >= 0 && h <= 360 && s >= 0 && s <= 100 && l >= 0 && l <= 100;
  };

  const hslToHex = (hsl: string) => {
    if (!isValidHsl(hsl)) return '#000000';
    const [h, s, l] = hsl.split(/\s+/).map(v => parseFloat(v.replace('%', '')));
    const c = (1 - Math.abs(2 * l / 100 - 1)) * s / 100;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l / 100 - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    const toHex = (v: number) => {
      const hex = Math.round((v + m) * 255).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  };

  const hexToHsl = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
  };

  const hexValue = hslToHex(value || "0 0% 0%");
  
  return (
    <div className="space-y-2">
      <Label htmlFor={testId}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={testId}
          type="color"
          value={hexValue}
          onChange={(e) => onChange(hexToHsl(e.target.value))}
          className="w-20 h-10"
          data-testid={`${testId}-picker`}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="H S% L%"
          className="flex-1 font-mono text-sm"
          data-testid={testId}
        />
      </div>
    </div>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: brandingSettings, isLoading } = useQuery<BrandingSettings>({
    queryKey: ["/api/branding"],
  });

  const [primaryColor, setPrimaryColor] = useState("218 70% 47%");
  const [accentColor, setAccentColor] = useState("25 95% 53%");
  const [backgroundColor, setBackgroundColor] = useState("0 0% 100%");
  const [cardColor, setCardColor] = useState("0 0% 100%");
  const [textColor, setTextColor] = useState("224 71% 4%");
  const [headingFont, setHeadingFont] = useState("Inter");
  const [bodyFont, setBodyFont] = useState("Inter");
  const [logoUrl, setLogoUrl] = useState("");
  const [spacing, setSpacing] = useState<string>("medium");
  const [borderRadius, setBorderRadius] = useState<string>("medium");

  const [companyName, setCompanyName] = useState("");
  const [disclaimer, setDisclaimer] = useState("");
  const [headerTemplate, setHeaderTemplate] = useState("");
  const [footerTemplate, setFooterTemplate] = useState("");
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const [firmName, setFirmName] = useState("");
  const [firmEmail, setFirmEmail] = useState("");
  const [firmPhone, setFirmPhone] = useState("");

  const [emailNewBuyer, setEmailNewBuyer] = useState(true);
  const [emailBuyerViews, setEmailBuyerViews] = useState(true);
  const [emailPhaseComplete, setEmailPhaseComplete] = useState(true);
  const [emailWeeklyDigest, setEmailWeeklyDigest] = useState(false);

  const [defaultExpiration, setDefaultExpiration] = useState("30");
  const [requireNda, setRequireNda] = useState(true);
  const [autoAdvancePhase, setAutoAdvancePhase] = useState(false);

  useEffect(() => {
    if (brandingSettings) {
      setPrimaryColor(brandingSettings.primaryColor);
      setAccentColor(brandingSettings.accentColor);
      setBackgroundColor(brandingSettings.backgroundColor);
      setCardColor(brandingSettings.cardColor);
      setTextColor(brandingSettings.textColor);
      setHeadingFont(brandingSettings.headingFont);
      setBodyFont(brandingSettings.bodyFont);
      setLogoUrl(brandingSettings.logoUrl || "");
      setSpacing(brandingSettings.spacing);
      setBorderRadius(brandingSettings.borderRadius);
      setCompanyName(brandingSettings.companyName || "");
      setDisclaimer(brandingSettings.disclaimer || "");
      setHeaderTemplate(brandingSettings.headerTemplate || "");
      setFooterTemplate(brandingSettings.footerTemplate || "");
    }
  }, [brandingSettings]);

  const saveBrandingMutation = useMutation({
    mutationFn: async (data: any) => {
      if (brandingSettings?.id) {
        return apiRequest("PATCH", `/api/branding/${brandingSettings.id}`, data);
      } else {
        return apiRequest("POST", "/api/branding", data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/branding"] });
      toast({
        title: "Settings Saved",
        description: "Your branding settings have been updated successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save settings. Please try again.",
        variant: "destructive",
      });
    },
  });

  const normalizeHslColor = (color: string): string => {
    const trimmed = color.trim();
    if (/^\d+\s+\d+%\s+\d+%$/.test(trimmed)) {
      return trimmed;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length === 3) {
      const h = parseInt(parts[0]);
      const s = parseInt(parts[1].replace('%', ''));
      const l = parseInt(parts[2].replace('%', ''));
      if (!isNaN(h) && !isNaN(s) && !isNaN(l)) {
        return `${h} ${s}% ${l}%`;
      }
    }
    return trimmed;
  };

  const handleLogoUpload = async (file: File) => {
    setUploadingLogo(true);
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const base64 = e.target?.result as string;
          const res = await fetch("/api/upload-logo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: base64, filename: file.name }),
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || "Upload failed");
          }
          const { url } = await res.json();
          setLogoUrl(url);
          toast({ title: "Logo Uploaded", description: "Your logo has been uploaded successfully." });
        } catch (err: any) {
          toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
        } finally {
          setUploadingLogo(false);
        }
      };
      reader.readAsDataURL(file);
    } catch {
      setUploadingLogo(false);
    }
  };

  const handleSaveBranding = () => {
    saveBrandingMutation.mutate({
      companyName: companyName || undefined,
      primaryColor: normalizeHslColor(primaryColor),
      accentColor: normalizeHslColor(accentColor),
      backgroundColor: normalizeHslColor(backgroundColor),
      cardColor: normalizeHslColor(cardColor),
      textColor: normalizeHslColor(textColor),
      headingFont,
      bodyFont,
      logoUrl: logoUrl || undefined,
      spacing,
      borderRadius,
      disclaimer: disclaimer || undefined,
      headerTemplate: headerTemplate || undefined,
      footerTemplate: footerTemplate || undefined,
    });
  };

  const handleSaveAccount = () => {
    toast({
      title: "Account Saved",
      description: "Your account settings have been updated.",
    });
  };

  const handleSaveNotifications = () => {
    toast({
      title: "Notifications Saved",
      description: "Your notification preferences have been updated.",
    });
  };

  const handleSaveDefaults = () => {
    toast({
      title: "Defaults Saved",
      description: "Your deal defaults have been updated.",
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center space-y-2">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal mx-auto"></div>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pt-6 pb-12 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage your account, preferences, and platform settings
        </p>
      </div>

      <Tabs defaultValue="account" className="w-full">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="account" className="flex items-center gap-2">
            <User className="h-4 w-4" />
            Account
          </TabsTrigger>
          <TabsTrigger value="notifications" className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="branding" className="flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Branding
          </TabsTrigger>
          <TabsTrigger value="defaults" className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Defaults
          </TabsTrigger>
          <TabsTrigger value="integrations" className="flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            Integrations
          </TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building className="h-5 w-5" />
                Firm Information
              </CardTitle>
              <CardDescription>Your brokerage or firm details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="firm-name">Firm Name</Label>
                <Input
                  id="firm-name"
                  placeholder="ABC Business Brokers"
                  value={firmName}
                  onChange={(e) => setFirmName(e.target.value)}
                  data-testid="input-firm-name"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="firm-email">Contact Email</Label>
                  <Input
                    id="firm-email"
                    type="email"
                    placeholder="info@abcbrokers.com"
                    value={firmEmail}
                    onChange={(e) => setFirmEmail(e.target.value)}
                    data-testid="input-firm-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="firm-phone">Phone Number</Label>
                  <Input
                    id="firm-phone"
                    placeholder="(555) 123-4567"
                    value={firmPhone}
                    onChange={(e) => setFirmPhone(e.target.value)}
                    data-testid="input-firm-phone"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Security
              </CardTitle>
              <CardDescription>Account security settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Two-Factor Authentication</p>
                  <p className="text-sm text-muted-foreground">Add an extra layer of security</p>
                </div>
                <Button variant="outline" data-testid="button-setup-2fa">
                  Set Up
                </Button>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Change Password</p>
                  <p className="text-sm text-muted-foreground">Update your account password</p>
                </div>
                <Button variant="outline" data-testid="button-change-password">
                  Change
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleSaveAccount} className="bg-teal text-teal-foreground hover:bg-teal/90" data-testid="button-save-account">
              <Save className="h-4 w-4 mr-2" />
              Save Account Settings
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="notifications" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                Email Notifications
              </CardTitle>
              <CardDescription>Choose when to receive email notifications</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">New Buyer Access</p>
                  <p className="text-sm text-muted-foreground">When a buyer is invited to view a CIM</p>
                </div>
                <Switch
                  checked={emailNewBuyer}
                  onCheckedChange={setEmailNewBuyer}
                  data-testid="switch-email-new-buyer"
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Buyer Views CIM</p>
                  <p className="text-sm text-muted-foreground">When a buyer opens or views a CIM</p>
                </div>
                <Switch
                  checked={emailBuyerViews}
                  onCheckedChange={setEmailBuyerViews}
                  data-testid="switch-email-buyer-views"
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Phase Completion</p>
                  <p className="text-sm text-muted-foreground">When a deal moves to the next phase</p>
                </div>
                <Switch
                  checked={emailPhaseComplete}
                  onCheckedChange={setEmailPhaseComplete}
                  data-testid="switch-email-phase-complete"
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Weekly Digest</p>
                  <p className="text-sm text-muted-foreground">Summary of all activity across your deals</p>
                </div>
                <Switch
                  checked={emailWeeklyDigest}
                  onCheckedChange={setEmailWeeklyDigest}
                  data-testid="switch-email-weekly-digest"
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleSaveNotifications} className="bg-teal text-teal-foreground hover:bg-teal/90" data-testid="button-save-notifications">
              <Save className="h-4 w-4 mr-2" />
              Save Notification Settings
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="branding" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Brand Colors</CardTitle>
              <CardDescription>
                These colors will be applied to your exported CIM documents
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <ColorInput
                  label="Primary Color"
                  value={primaryColor}
                  onChange={setPrimaryColor}
                  testId="input-primary-color"
                />
                <ColorInput
                  label="Accent Color"
                  value={accentColor}
                  onChange={setAccentColor}
                  testId="input-accent-color"
                />
              </div>
              <Separator />
              <div className="grid gap-6 sm:grid-cols-3">
                <ColorInput
                  label="Background"
                  value={backgroundColor}
                  onChange={setBackgroundColor}
                  testId="input-background-color"
                />
                <ColorInput
                  label="Card Color"
                  value={cardColor}
                  onChange={setCardColor}
                  testId="input-card-color"
                />
                <ColorInput
                  label="Text Color"
                  value={textColor}
                  onChange={setTextColor}
                  testId="input-text-color"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Typography & Design</CardTitle>
              <CardDescription>Configure fonts and spacing for CIM documents</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Heading Font</Label>
                  <Select value={headingFont} onValueChange={setHeadingFont}>
                    <SelectTrigger data-testid="select-heading-font">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Inter">Inter</SelectItem>
                      <SelectItem value="Roboto">Roboto</SelectItem>
                      <SelectItem value="Open Sans">Open Sans</SelectItem>
                      <SelectItem value="Lato">Lato</SelectItem>
                      <SelectItem value="Montserrat">Montserrat</SelectItem>
                      <SelectItem value="Poppins">Poppins</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Body Font</Label>
                  <Select value={bodyFont} onValueChange={setBodyFont}>
                    <SelectTrigger data-testid="select-body-font">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Inter">Inter</SelectItem>
                      <SelectItem value="Roboto">Roboto</SelectItem>
                      <SelectItem value="Open Sans">Open Sans</SelectItem>
                      <SelectItem value="Lato">Lato</SelectItem>
                      <SelectItem value="Montserrat">Montserrat</SelectItem>
                      <SelectItem value="Poppins">Poppins</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Spacing</Label>
                  <Select value={spacing} onValueChange={setSpacing}>
                    <SelectTrigger data-testid="select-spacing">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="small">Compact</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="large">Spacious</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Border Radius</Label>
                  <Select value={borderRadius} onValueChange={setBorderRadius}>
                    <SelectTrigger data-testid="select-border-radius">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="small">Sharp</SelectItem>
                      <SelectItem value="medium">Rounded</SelectItem>
                      <SelectItem value="large">Very Rounded</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Brokerage Name</CardTitle>
              <CardDescription>Your firm name as it appears on CIM documents</CardDescription>
            </CardHeader>
            <CardContent>
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. A R Business Brokers Inc."
                data-testid="input-company-name"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Logo</CardTitle>
              <CardDescription>Upload your firm logo for CIM cover pages and headers</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {logoUrl ? (
                <div className="border rounded-lg p-4 bg-muted/50">
                  <div className="flex items-start justify-between gap-4">
                    <img 
                      src={logoUrl} 
                      alt="Logo preview" 
                      className="max-h-24 object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setLogoUrl("")}
                      data-testid="button-remove-logo"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <label
                  htmlFor="logo-file-input"
                  className="flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-8 cursor-pointer hover-elevate transition-colors"
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const file = e.dataTransfer.files?.[0];
                    if (file && file.type.startsWith("image/")) handleLogoUpload(file);
                  }}
                >
                  {uploadingLogo ? (
                    <div className="text-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">Uploading...</p>
                    </div>
                  ) : (
                    <>
                      <Image className="h-10 w-10 text-muted-foreground mb-3" />
                      <p className="text-sm font-medium">Drop your logo here or click to browse</p>
                      <p className="text-xs text-muted-foreground mt-1">PNG, JPG, SVG, or WebP (max 5MB)</p>
                    </>
                  )}
                  <input
                    id="logo-file-input"
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleLogoUpload(file);
                    }}
                    data-testid="input-logo-file"
                  />
                </label>
              )}
              <Separator />
              <div className="space-y-2">
                <Label htmlFor="logo-url-fallback" className="text-xs text-muted-foreground">Or enter a URL</Label>
                <Input
                  id="logo-url-fallback"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://example.com/logo.png"
                  className="text-sm"
                  data-testid="input-logo-url"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Confidentiality & Disclaimer</CardTitle>
              <CardDescription>Legal text that appears at the start of every CIM/CBO document</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={disclaimer}
                onChange={(e) => setDisclaimer(e.target.value)}
                placeholder="Enter your Notice of Confidentiality & Disclaimer text..."
                rows={10}
                className="text-sm"
                data-testid="input-disclaimer"
              />
              <Button
                variant="outline"
                onClick={() => setDisclaimer(`Notice of Confidentiality\n${companyName || '[Your Brokerage Name]'} represents the client on an exclusive basis. The information presented in this document is highly sensitive and confidential and is for the use only by those who signed the NDA as deemed necessary by the Broker's sole judgement for the purpose of considering the Business or the vendor's or company's business described herein for acquisition. The Confidential Business Overview ("CBO") and the information presented shall be treated as Secret and Confidential and no part of it shall be disclosed to others, except as provided in the NDA or NINDA. It is highly important to the Business and its current owner(s) that all Confidential Information be held in the strictest of confidence. The Business could be seriously damaged should word that "the Business is for sale" reach its employees, customers, competitors and/or others, or should information contained herein fall into other wrong hands. This CBO cannot be reproduced, duplicated, shared, or revealed, in whole or in part, or used in any other manner without the prior written permission of ${companyName || '[Your Brokerage Name]'}.\n\nDisclaimer\nThe Vendor has supplied the information contained in this Document. ${companyName || '[Your Brokerage Name]'} has not audited or otherwise confirmed this information and makes no representations, expressed or implied, as to its accuracy or completeness or the conclusion to be drawn, and shall in no way be responsible for the content, accuracy, and truthfulness of such information. Any and all representations shall be made solely by the Vendor as set forth in a signed agreement, or purchase contract, which agreement or contract shall control the representations and warranties, if any. By requesting this information package or CBO, the recipient, user or reader acknowledges the responsibility of non-disclosure and to perform a due diligence review prior to the acquisition of the Business, or Company, or assets thereof.`)}
                data-testid="button-prefill-disclaimer"
              >
                Pre-fill with Standard Template
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Page Footer</CardTitle>
              <CardDescription>Text that appears at the bottom of every page in the CIM/CBO</CardDescription>
            </CardHeader>
            <CardContent>
              <Input
                value={footerTemplate}
                onChange={(e) => setFooterTemplate(e.target.value)}
                placeholder="e.g. PRIVATE & CONFIDENTIAL | {businessName} | A R Business Brokers Inc."
                data-testid="input-footer-template"
              />
              <p className="text-xs text-muted-foreground mt-2">
                Use {"{businessName}"} to insert the business name dynamically
              </p>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button
              onClick={handleSaveBranding}
              disabled={saveBrandingMutation.isPending}
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              data-testid="button-save-branding"
            >
              <Save className="h-4 w-4 mr-2" />
              {saveBrandingMutation.isPending ? "Saving..." : "Save Branding Settings"}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="defaults" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5" />
                Deal Defaults
              </CardTitle>
              <CardDescription>Default settings for new deals</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Default Buyer Link Expiration</Label>
                <Select value={defaultExpiration} onValueChange={setDefaultExpiration}>
                  <SelectTrigger data-testid="select-default-expiration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="14">14 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="60">60 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Default expiration period for buyer access links
                </p>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Require NDA Before Phase 2</p>
                  <p className="text-sm text-muted-foreground">
                    Require NDA to be signed before starting platform intake
                  </p>
                </div>
                <Switch
                  checked={requireNda}
                  onCheckedChange={setRequireNda}
                  data-testid="switch-require-nda"
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Auto-Advance Phases</p>
                  <p className="text-sm text-muted-foreground">
                    Automatically advance to next phase when requirements are met
                  </p>
                </div>
                <Switch
                  checked={autoAdvancePhase}
                  onCheckedChange={setAutoAdvancePhase}
                  data-testid="switch-auto-advance"
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleSaveDefaults} className="bg-teal text-teal-foreground hover:bg-teal/90" data-testid="button-save-defaults">
              <Save className="h-4 w-4 mr-2" />
              Save Default Settings
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="integrations" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="h-5 w-5" />
                CRM Integrations
              </CardTitle>
              <CardDescription>Connect your CRM to sync buyer and deal data</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-orange-100 dark:bg-orange-900/30">
                    <Building className="h-5 w-5 text-orange-600" />
                  </div>
                  <div>
                    <p className="font-medium">HubSpot</p>
                    <p className="text-sm text-muted-foreground">Sync contacts and deals</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Coming Soon</Badge>
                </div>
              </div>
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                    <Building className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-medium">Salesforce</p>
                    <p className="text-sm text-muted-foreground">Enterprise CRM integration</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Coming Soon</Badge>
                </div>
              </div>
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900/30">
                    <Building className="h-5 w-5 text-green-600" />
                  </div>
                  <div>
                    <p className="font-medium">Pipedrive</p>
                    <p className="text-sm text-muted-foreground">Sales pipeline management</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Coming Soon</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                Email Integrations
              </CardTitle>
              <CardDescription>Connect email services for notifications</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                    <Mail className="h-5 w-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="font-medium">SendGrid</p>
                    <p className="text-sm text-muted-foreground">Transactional email delivery</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Coming Soon</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Team Management
              </CardTitle>
              <CardDescription>Manage team members and permissions</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8">
                <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <p className="text-muted-foreground">Team management coming soon</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Invite team members and manage access levels
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
