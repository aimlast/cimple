import { Upload, File, X } from "lucide-react";
import { useState, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface UploadedFile {
  id: string;
  name: string;
  size: string;
  file: File;
}

export function DocumentUploadZone() {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    
    const newFiles: UploadedFile[] = Array.from(fileList).map((file) => ({
      id: `${Date.now()}-${Math.random()}`,
      name: file.name,
      size: formatFileSize(file.size),
      file: file,
    }));
    
    setFiles([...files, ...newFiles]);
    console.log(`Added ${newFiles.length} file(s):`, newFiles.map(f => f.name));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files);
    if (e.target) {
      e.target.value = '';
    }
  };

  const removeFile = (id: string) => {
    setFiles(files.filter((f) => f.id !== id));
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
        onChange={handleFileInputChange}
        className="hidden"
        data-testid="input-file-hidden"
      />
      
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "border-2 border-dashed rounded-lg p-8 text-center transition-colors min-h-48 flex flex-col items-center justify-center",
          isDragging
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/50"
        )}
      >
        <Upload className="h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-sm font-medium mb-1">
          Drag and drop files here, or click to browse
        </p>
        <p className="text-xs text-muted-foreground mb-4">
          Supports PDF, Word, Excel, CSV, TXT
        </p>
        <Button onClick={handleFileSelect} data-testid="button-upload">
          Select Files
        </Button>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-3 p-3 rounded-lg bg-card border border-card-border"
            >
              <File className="h-5 w-5 text-primary" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">{file.size}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeFile(file.id)}
                data-testid={`button-remove-${file.id}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
